/**
 * Electron Window Protection Manager
 * Integrates AppleScript-based window protection into Electron apps
 * 
 * Usage:
 * const ProtectionManager = require('./protection-manager');
 * const protection = new ProtectionManager(options);
 * protection.init(); // Call after app is ready
 */

const { app, ipcMain, screen } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

class ProtectionManager {
    constructor(options = {}) {
        // Default configuration
        this.config = {
            area: options.area || { x: 0, y: 0, width: 320, height: 1080 },
            excludeApps: options.excludeApps || ["SystemUIServer", "Dock", "Finder"],
            scriptPath: options.scriptPath || path.join(__dirname, 'protect_area.applescript'),
            enabled: options.enabled !== undefined ? options.enabled : false,
            checkInterval: options.checkInterval || 500,
            autoStart: options.autoStart !== undefined ? options.autoStart : false,
            ...options
        };
        
        this.protectionProcess = null;
        this.isSupported = process.platform === 'darwin'; // macOS only for now
        this._ipcRegistered = false;
        this.lastError = null;
        this._tmpExtractedScript = null; // path to temp script if we had to extract
        
        // Bind methods to preserve context
        this.start = this.start.bind(this);
        this.stop = this.stop.bind(this);
        this.toggle = this.toggle.bind(this);
        this.getStatus = this.getStatus.bind(this);
        this.updateConfig = this.updateConfig.bind(this);
    }

    /** Remove temporary extracted AppleScript if we created one */
    _cleanupTmpScript() {
        try {
            if (this._tmpExtractedScript && fs.existsSync(this._tmpExtractedScript)) {
                fs.unlinkSync(this._tmpExtractedScript);
            }
        } catch (e) {
            // best effort
        } finally {
            this._tmpExtractedScript = null;
        }
    }

    /**
     * Initialize the protection manager and register IPC handlers
     * Call this after app.whenReady()
     */
    init() {
        if (!this.isSupported) {
            console.warn('[ProtectionManager] Window protection is only supported on macOS');
            return;
        }
        if (this._ipcRegistered) {
            return; // already initialized
        }

        this.registerIPCHandlers();
        
        if (this.config.autoStart) {
            this.start();
        }

        console.log('[ProtectionManager] Initialized with config:', this.config);
    }

    /**
     * Register IPC handlers for renderer process communication
     */
    registerIPCHandlers() {
        if (this._ipcRegistered) return;

        // Get current protection status
        ipcMain.handle('protection-status', async () => {
            return this.getStatus();
        });

        // Toggle protection on/off
        ipcMain.handle('protection-toggle', async (event, enabled) => {
            if (enabled !== undefined) {
                return enabled ? this.start() : this.stop();
            }
            return this.toggle();
        });

        // Update protection configuration
        ipcMain.handle('protection-config', async (event, newConfig) => {
            return this.updateConfig(newConfig);
        });

        // Get screen information for UI configuration
        ipcMain.handle('protection-screen-info', async () => {
            const displays = screen.getAllDisplays();
            return {
                primary: screen.getPrimaryDisplay(),
                all: displays,
                workArea: screen.getPrimaryDisplay().workAreaSize
            };
        });

        this._ipcRegistered = true;
    }

    /**
     * Resolve an AppleScript path that works in dev and in asar-packed production.
     * If the script is inside an asar, extract it to a temp file so `osascript` can read it.
     */
    _resolveScriptPath() {
        let candidate = this.config.scriptPath;
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch {}

        // Fallback to local file next to this module
        const local = path.join(__dirname, 'protect_area.applescript');
        const localDash = path.join(__dirname, 'protect-area.applescript');
        if (fs.existsSync(local)) return local;
        if (fs.existsSync(localDash)) return localDash;

        // If bundled inside asar, Electron exposes paths like app.asar/...; osascript cannot read inside asar.
        // Attempt to extract to a temp file.
        try {
            const asarGuess = local;
            const data = fs.readFileSync(asarGuess);
            const tmp = path.join(os.tmpdir(), `protect_area_${Date.now()}.applescript`);
            fs.writeFileSync(tmp, data, { mode: 0o644 });
            this._tmpExtractedScript = tmp;
            return tmp;
        } catch (e) {
            return candidate; // let the caller fail with a clear error
        }
    }

    /**
     * Start the protection system
     */
    async start() {
        if (!this.isSupported) {
            return { success: false, error: 'Platform not supported' };
        }

        if (this.protectionProcess) {
            console.log('[ProtectionManager] Protection already running');
            return { success: true, status: this.getStatus() };
        }

        if (!app.isReady()) {
            const msg = '[ProtectionManager] Cannot start before app is ready';
            console.warn(msg);
            return { success: false, error: msg };
        }

        try {
            // Resolve script path for dev/prod
            const actualScriptPath = this._resolveScriptPath();
            if (!fs.existsSync(actualScriptPath)) {
                throw new Error(`AppleScript file not found: ${actualScriptPath}`);
            }

            // Update screen height based on current display
            const primaryDisplay = screen.getPrimaryDisplay();
            const screenHeight = primaryDisplay.workAreaSize.height;
            
            // If height is default (1080), update to actual screen height
            if (this.config.area.height === 1080) {
                this.config.area.height = screenHeight;
            }

            // Prepare AppleScript arguments
            const args = [
                actualScriptPath,
                this.config.area.x.toString(),
                this.config.area.y.toString(),
                this.config.area.width.toString(),
                this.config.area.height.toString(),
                this.config.excludeApps.join(',')
            ];

            console.log('[ProtectionManager] Starting protection with args:', args);

            // Spawn AppleScript process
            this.protectionProcess = spawn('osascript', args, {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            // Handle process events
            this.protectionProcess.stdout.on('data', (data) => {
                console.log('[ProtectionManager] Script output:', data.toString().trim());
            });

            this.protectionProcess.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                this.lastError = msg;
                console.error('[ProtectionManager] Script error:', msg);
            });

            this.protectionProcess.on('error', (err) => {
                console.error('[ProtectionManager] Process error:', err);
                this.protectionProcess = null;
            });

            this.protectionProcess.on('exit', (code, signal) => {
                console.log(`[ProtectionManager] Process exited with code ${code}, signal ${signal}`);
                this.protectionProcess = null;
            });

            this.config.enabled = true;
            
            return { success: true, status: this.getStatus() };

        } catch (error) {
            console.error('[ProtectionManager] Failed to start protection:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Stop the protection system
     */
    async stop() {
        if (this.protectionProcess) {
            console.log('[ProtectionManager] Stopping protection...');
            this.protectionProcess.kill('SIGTERM');
            this.protectionProcess = null;
        }

        this.config.enabled = false;
        return { success: true, status: this.getStatus() };
    }

    /**
     * Toggle protection on/off
     */
    async toggle() {
        return this.config.enabled ? this.stop() : this.start();
    }

    /**
     * Get current protection status
     */
    getStatus() {
        return {
            enabled: this.config.enabled,
            running: !!this.protectionProcess,
            supported: this.isSupported,
            config: { ...this.config },
            pid: this.protectionProcess ? this.protectionProcess.pid : null,
            lastError: this.lastError
        };
    }

    /**
     * Update protection configuration
     */
    async updateConfig(newConfig) {
        try {
            const wasRunning = !!this.protectionProcess;
            
            // Stop protection if running
            if (wasRunning) {
                await this.stop();
            }

            // Update configuration
            if (newConfig.area) {
                this.config.area = { ...this.config.area, ...newConfig.area };
            }
            if (newConfig.excludeApps) {
                this.config.excludeApps = [...newConfig.excludeApps];
            }
            if (newConfig.checkInterval !== undefined) {
                this.config.checkInterval = newConfig.checkInterval;
            }

            console.log('[ProtectionManager] Configuration updated:', this.config);

            // Restart protection if it was running
            if (wasRunning) {
                return this.start();
            }

            return { success: true, status: this.getStatus() };

        } catch (error) {
            console.error('[ProtectionManager] Failed to update config:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Clean shutdown - call this in app.on('before-quit')
     */
    async shutdown() {
        console.log('[ProtectionManager] Shutting down...');
        await this.stop();
        this._cleanupTmpScript();
        
        // Remove IPC handlers
        ipcMain.removeHandler('protection-status');
        ipcMain.removeHandler('protection-toggle');
        ipcMain.removeHandler('protection-config');
        ipcMain.removeHandler('protection-screen-info');

        this._ipcRegistered = false;
        this.lastError = null;
    }

    /**
     * Static method to create and initialize protection manager
     */
    static create(options = {}) {
        return new ProtectionManager(options);
    }
}

module.exports = ProtectionManager;

/**
 * Example usage in main.js:
 * 
 * const ProtectionManager = require('./protection-manager');
 * const { app } = require('electron');
 * 
 * const protection = new ProtectionManager({
 *   area: { x: 0, y: 0, width: 320, height: 1080 },
 *   excludeApps: ["MyApp", "SystemUIServer", "Dock"],
 *   autoStart: false
 * });
 * 
 * app.whenReady().then(() => {
 *   protection.init();
 * });
 * 
 * app.on('before-quit', () => {
 *   protection.shutdown();
 * });
 */