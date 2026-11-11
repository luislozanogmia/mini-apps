/**
 * Electron Window Protection Control Component
 * React/TypeScript UI for controlling window protection system
 * 
 * Usage:
 * import { ProtectionControl } from './ProtectionControl';
 * 
 * <ProtectionControl 
 *   showConfiguration={true}
 *   onStatusChange={(status) => console.log(status)}
 * />
 */

import React, { useState, useEffect, useCallback } from 'react';

// Type definitions
export interface ProtectionArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProtectionConfig {
  area: ProtectionArea;
  excludeApps: string[];
  checkInterval: number;
  enabled: boolean;
}

export interface ProtectionStatus {
  enabled: boolean;
  running: boolean;
  supported: boolean;
  config: ProtectionConfig;
  pid?: number | null;
  lastError?: string | null; // surfaced from ProtectionManager stderr
}

export interface ScreenInfo {
  primary: {
    workAreaSize: { width: number; height: number };
    bounds: { x: number; y: number; width: number; height: number };
  };
  all: Array<any>;
  workArea: { width: number; height: number };
}

// Component props
export interface ProtectionControlProps {
  className?: string;
  showConfiguration?: boolean;
  showAdvanced?: boolean;
  compactMode?: boolean;
  onStatusChange?: (status: ProtectionStatus) => void;
  onError?: (error: string) => void;
  theme?: 'light' | 'dark' | 'auto';
}

// Default styles (can be overridden with className)
const defaultStyles: Record<string, React.CSSProperties> = {
  container: {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    padding: '16px',
    border: '1px solid #e0e0e0',
    borderRadius: '8px',
    backgroundColor: '#ffffff',
    maxWidth: '400px'
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '12px'
  },
  title: {
    margin: 0,
    fontSize: '16px',
    fontWeight: '600',
    color: '#333333'
  },
  status: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '14px'
  },
  indicator: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    flexShrink: 0
  },
  button: {
    padding: '8px 16px',
    border: '1px solid #007AFF',
    borderRadius: '6px',
    backgroundColor: '#007AFF',
    color: 'white',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: '500'
  },
  buttonSecondary: {
    backgroundColor: 'transparent',
    color: '#007AFF'
  },
  buttonDisabled: {
    backgroundColor: '#f0f0f0',
    borderColor: '#d0d0d0',
    color: '#999999',
    cursor: 'not-allowed'
  },
  configSection: {
    marginTop: '16px',
    padding: '12px',
    backgroundColor: '#f8f9fa',
    borderRadius: '6px',
    border: '1px solid #e9ecef'
  },
  configTitle: {
    fontSize: '14px',
    fontWeight: '600',
    marginBottom: '8px',
    color: '#333333'
  },
  inputGroup: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
    marginBottom: '12px'
  },
  inputRow: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center'
  },
  label: {
    fontSize: '12px',
    color: '#666666',
    minWidth: '60px'
  },
  input: {
    padding: '4px 8px',
    border: '1px solid #d0d0d0',
    borderRadius: '4px',
    fontSize: '13px',
    width: '80px'
  },
  textarea: {
    padding: '8px',
    border: '1px solid #d0d0d0',
    borderRadius: '4px',
    fontSize: '13px',
    width: '100%',
    minHeight: '60px',
    resize: 'vertical' as const
  },
  error: {
    color: '#dc3545',
    fontSize: '12px',
    marginTop: '8px'
  },
  unsupported: {
    padding: '12px',
    backgroundColor: '#fff3cd',
    border: '1px solid #ffeaa7',
    borderRadius: '6px',
    color: '#856404',
    fontSize: '14px'
  }
};

export const ProtectionControl: React.FC<ProtectionControlProps> = ({
  className,
  showConfiguration = false,
  showAdvanced = false,
  compactMode = false,
  onStatusChange,
  onError,
  theme = 'auto'
}) => {
  const [status, setStatus] = useState<ProtectionStatus | null>(null);
  const [screenInfo, setScreenInfo] = useState<ScreenInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(showConfiguration);

  // Local config state for editing
  const [localConfig, setLocalConfig] = useState<ProtectionConfig | null>(null);

  // Check if window.electronAPI is available
  const isElectronAvailable = typeof window !== 'undefined' && (window as any).electronAPI;

  // Fetch current status
  const fetchStatus = useCallback(async () => {
    if (!isElectronAvailable) return;

    try {
      const result = await (window as any).electronAPI.protectionStatus();
      setStatus(result);
      setLocalConfig(result.config);
      onStatusChange?.(result);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to fetch status';
      setError(errorMsg);
      onError?.(errorMsg);
    }
  }, [isElectronAvailable, onStatusChange, onError]);

  // Fetch screen info for configuration
  const fetchScreenInfo = useCallback(async () => {
    if (!isElectronAvailable) return;

    try {
      const result = await (window as any).electronAPI.protectionScreenInfo();
      setScreenInfo(result);
    } catch (err) {
      console.warn('Failed to fetch screen info:', err);
    }
  }, [isElectronAvailable]);

  // Toggle protection
  const toggleProtection = async () => {
    if (!isElectronAvailable || loading) return;

    setLoading(true);
    setError(null);

    try {
      const desired = !(status?.enabled ?? false);
      const result = await (window as any).electronAPI.protectionToggle(desired);
      if (result?.success) {
        await fetchStatus();
      } else {
        throw new Error(result?.error || 'Failed to toggle protection');
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to toggle protection';
      setError(errorMsg);
      onError?.(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  // Apply configuration changes
  const applyConfig = async () => {
    if (!isElectronAvailable || !localConfig || loading) return;

    setLoading(true);
    setError(null);

    try {
      const result = await (window as any).electronAPI.protectionConfig(localConfig);
      if (result.success) {
        await fetchStatus();
      } else {
        throw new Error(result.error || 'Failed to apply configuration');
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to apply configuration';
      setError(errorMsg);
      onError?.(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  // Initialize component
  useEffect(() => {
    if (isElectronAvailable) {
      fetchStatus();
      fetchScreenInfo();
    }
  }, [fetchStatus, fetchScreenInfo]);

  // Handle local config changes
  const updateLocalConfig = (updates: Partial<ProtectionConfig>) => {
    if (!localConfig) return;
    setLocalConfig({ ...localConfig, ...updates });
  };

  const updateArea = (updates: Partial<ProtectionArea>) => {
    if (!localConfig) return;
    setLocalConfig({
      ...localConfig,
      area: { ...localConfig.area, ...updates }
    });
  };

  // Get status indicator color
  const getIndicatorColor = () => {
    if (!status?.supported) return '#999999';
    if (status.enabled && status.running) return '#28a745';
    if (status.enabled && !status.running) return '#ffc107';
    return '#dc3545';
  };

  // Get status text
  const getStatusText = () => {
    if (!status?.supported) return 'Not supported';
    if (status.enabled && status.running) return 'Active';
    if (status.enabled && !status.running) {
      return status.lastError ? 'Error' : 'Starting...';
    }
    return 'Disabled';
  };

  // Render unsupported state
  if (status && !status.supported) {
    return (
      <div className={className} style={defaultStyles.container}>
        <div style={defaultStyles.unsupported}>
          Window protection is only supported on macOS (darwin). Other platforms coming soon.
        </div>
      </div>
    );
  }

  // Render loading state
  if (!status && isElectronAvailable) {
    return (
      <div className={className} style={defaultStyles.container}>
        <div style={defaultStyles.status}>
          <div style={{ ...defaultStyles.indicator, backgroundColor: '#999999' }} />
          Loading protection status...
        </div>
      </div>
    );
  }

  // Render no Electron API state
  if (!isElectronAvailable) {
    return (
      <div className={className} style={defaultStyles.container}>
        <div style={defaultStyles.error}>
          Electron API not available. This component requires an Electron environment.
        </div>
      </div>
    );
  }

  return (
    <div className={className} style={defaultStyles.container}>
      {/* Header */}
      {!compactMode && (
        <div style={defaultStyles.header}>
          <h3 style={defaultStyles.title}>Window Protection</h3>
          <div style={defaultStyles.status}>
            <div 
              style={{ 
                ...defaultStyles.indicator, 
                backgroundColor: getIndicatorColor() 
              }} 
            />
            <span>{getStatusText()}</span>
          </div>
        </div>
      )}

      {/* Toggle Button */}
      <button
        style={{
          ...defaultStyles.button,
          ...(loading ? defaultStyles.buttonDisabled : {}),
          width: compactMode ? 'auto' : '100%'
        }}
        onClick={toggleProtection}
        disabled={loading || !status?.supported}
      >
        {loading ? 'Loading...' : status?.enabled ? 'Disable Protection' : 'Enable Protection'}
      </button>

      {/* Configuration Toggle */}
      {!compactMode && showConfiguration && (
        <button
          style={{
            ...defaultStyles.button,
            ...defaultStyles.buttonSecondary,
            width: '100%',
            marginTop: '8px'
          }}
          onClick={() => setShowConfig(!showConfig)}
        >
          {showConfig ? 'Hide Configuration' : 'Show Configuration'}
        </button>
      )}

      {/* Configuration Panel */}
      {showConfig && localConfig && (
        <div style={defaultStyles.configSection}>
          <div style={defaultStyles.configTitle}>Protection Area</div>
          
          <div style={defaultStyles.inputGroup}>
            <div style={defaultStyles.inputRow}>
              <label style={defaultStyles.label}>X:</label>
              <input
                style={defaultStyles.input}
                type="number"
                value={localConfig.area.x}
                onChange={(e) => updateArea({ x: parseInt(e.target.value) || 0 })}
              />
              <label style={defaultStyles.label}>Y:</label>
              <input
                style={defaultStyles.input}
                type="number"
                value={localConfig.area.y}
                onChange={(e) => updateArea({ y: parseInt(e.target.value) || 0 })}
              />
            </div>
            <div style={defaultStyles.inputRow}>
              <label style={defaultStyles.label}>Width:</label>
              <input
                style={defaultStyles.input}
                type="number"
                value={localConfig.area.width}
                onChange={(e) => updateArea({ width: parseInt(e.target.value) || 0 })}
              />
              <label style={defaultStyles.label}>Height:</label>
              <input
                style={defaultStyles.input}
                type="number"
                value={localConfig.area.height}
                onChange={(e) => updateArea({ height: parseInt(e.target.value) || 0 })}
              />
            </div>
          </div>

          {/* Screen info helper */}
          {screenInfo && (
            <div style={{ fontSize: '12px', color: '#666666', marginBottom: '12px' }}>
              Screen: {screenInfo.workArea.width} × {screenInfo.workArea.height}
            </div>
          )}

          {/* Exclude Apps */}
          <div style={defaultStyles.configTitle}>Exclude Apps (one per line)</div>
          <textarea
            style={defaultStyles.textarea}
            value={localConfig.excludeApps.join('\n')}
            onChange={(e) => updateLocalConfig({ 
              excludeApps: e.target.value.split('\n').filter(app => app.trim()) 
            })}
            placeholder="SystemUIServer&#10;Dock&#10;Finder&#10;Your App Name"
          />

          {/* Advanced Settings */}
          {showAdvanced && (
            <>
              <div style={defaultStyles.configTitle}>Check Interval (ms)</div>
              <input
                style={{ ...defaultStyles.input, width: '100%' }}
                type="number"
                value={localConfig.checkInterval}
                onChange={(e) => updateLocalConfig({ 
                  checkInterval: parseInt(e.target.value) || 500 
                })}
                min="100"
                max="5000"
                step="100"
              />
            </>
          )}

          {/* Apply Button */}
          <button
            style={{
              ...defaultStyles.button,
              width: '100%',
              marginTop: '12px'
            }}
            onClick={applyConfig}
            disabled={loading}
          >
            {loading ? 'Applying...' : 'Apply Configuration'}
          </button>
        </div>
      )}

      {/* Error Message */}
      {(error || status?.lastError) && (
        <div style={defaultStyles.error}>
          {error || status?.lastError}
        </div>
      )}
    </div>
  );
};

export default ProtectionControl;

/**
 * Example usage:
 * 
 * // Basic usage
 * <ProtectionControl />
 * 
 * // With configuration panel
 * <ProtectionControl 
 *   showConfiguration={true}
 *   onStatusChange={(status) => console.log('Protection status:', status)}
 *   onError={(error) => console.error('Protection error:', error)}
 * />
 * 
 * // Compact mode
 * <ProtectionControl compactMode={true} />
 * 
 * // With custom styling
 * <ProtectionControl className="my-custom-protection-control" />
 */