#!/usr/bin/env python3
"""
GPU Keepalive: RTX P-State Management for Local LLM Inference
============================================================

EXPERIMENTAL RESEARCH TOOL for preventing RTX GPU performance degradation 
by maintaining P0 power state during inference. Addresses the widespread 
issue where RTX cards drop from P0 to P8, causing 4x performance loss.

⚠️  DISCLAIMER: This is a research and demonstration tool. Tested primarily 
on RTX 3070 Laptop (85W). Use for research, testing, and experimentation.
Not recommended for production deployments without thorough validation.

Author: Project contributors
License: MIT
Included in mini-apps/tools/gpu-keepalive

Usage:
    from gpu_keepalive import GPUKeepalive
    
    # Start keepalive
    keepalive = GPUKeepalive()
    keepalive.start()
    
    # Your LLM inference code here
    # GPU stays in P0 state automatically
    
    # Stop when done
    keepalive.stop()
"""

import time
import torch
import threading
import signal
import sys
from typing import Optional
from contextlib import contextmanager


class GPUKeepalive:
    """
    Maintains RTX GPU in P0 power state through minimal background CUDA operations.
    
    This class solves the RTX P-state problem where GPUs automatically transition
    from P0 (maximum performance) to P8 (power-saving) between inference requests,
    causing dramatic performance degradation.
    """
    
    def __init__(
        self,
        device_id: int = 0,
        keepalive_interval: float = 0.1,
        tensor_size: tuple = (256, 256),
        auto_thermal_protection: bool = True,
        max_temperature: float = 83.0,
        debug: bool = False
    ):
        """
        Initialize GPU Keepalive manager.
        
        Args:
            device_id: CUDA device ID (0 for primary GPU)
            keepalive_interval: Seconds between keepalive operations
            tensor_size: Size of keepalive tensor (memory vs frequency trade-off)
            auto_thermal_protection: Enable automatic thermal throttling
            max_temperature: Maximum GPU temperature before thermal protection
            debug: Enable debug logging
        """
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA not available. GPU Keepalive requires CUDA-enabled GPU.")
        
        if device_id >= torch.cuda.device_count():
            raise ValueError(f"Device {device_id} not available. Found {torch.cuda.device_count()} GPUs.")
        
        self.device = torch.device(f"cuda:{device_id}")
        self.keepalive_interval = keepalive_interval
        self.tensor_size = tensor_size
        self.auto_thermal_protection = auto_thermal_protection
        self.max_temperature = max_temperature
        self.debug = debug
        
        # State management
        self.running = False
        self.paused = False
        self.generation_active = False
        self._thread: Optional[threading.Thread] = None
        self._generation_lock = threading.Lock()
        
        # Initialize keepalive tensor
        with torch.cuda.device(self.device):
            self.keepalive_tensor = torch.randn(
                tensor_size, 
                device=self.device, 
                dtype=torch.float16
            )
        
        # Operation counter for monitoring
        self.operation_count = 0
        
        self._log(f"GPU Keepalive initialized for {torch.cuda.get_device_name(device_id)}")
    
    def _log(self, message: str) -> None:
        """Debug logging with GPU Keepalive prefix."""
        if self.debug:
            print(f"[GPU_KEEPALIVE] {message}")
    
    def _get_gpu_temperature(self) -> Optional[float]:
        """Get current GPU temperature if available."""
        try:
            # Try nvidia-ml-py first
            import pynvml
            pynvml.nvmlInit()
            handle = pynvml.nvmlDeviceGetHandleByIndex(self.device.index)
            temp = pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
            return float(temp)
        except ImportError:
            # Fallback: try nvidia-smi subprocess
            try:
                import subprocess
                result = subprocess.run(
                    ['nvidia-smi', '--query-gpu=temperature.gpu', '--format=csv,noheader,nounits'],
                    capture_output=True, text=True, timeout=2
                )
                if result.returncode == 0:
                    temps = result.stdout.strip().split('\n')
                    if self.device.index < len(temps):
                        return float(temps[self.device.index])
            except (FileNotFoundError, subprocess.TimeoutExpired, ValueError):
                pass
        except Exception:
            pass
        return None
    
    def _should_pause_for_thermal(self) -> bool:
        """Check if keepalive should pause due to thermal concerns."""
        if not self.auto_thermal_protection:
            return False
        
        temp = self._get_gpu_temperature()
        if temp is None:
            return False
        
        if temp > self.max_temperature:
            self._log(f"Thermal protection activated: {temp}°C > {self.max_temperature}°C")
            return True
        
        return False
    
    def _keepalive_loop(self) -> None:
        """Main keepalive loop running in background thread."""
        self._log("Starting GPU keepalive loop")
        
        while self.running:
            try:
                # Skip if generation is active or thermal protection triggered
                if (self.generation_active or 
                    self.paused or 
                    self._should_pause_for_thermal()):
                    time.sleep(self.keepalive_interval)
                    continue
                
                # Perform minimal CUDA operation to maintain P0 state
                with torch.cuda.device(self.device):
                    with torch.no_grad():
                        # Single matrix operation - minimal but sufficient
                        temp_result = self.keepalive_tensor * 0.99
                        torch.cuda.synchronize()
                        del temp_result
                
                self.operation_count += 1
                
                # Log progress every 10 seconds
                if self.operation_count % int(10 / self.keepalive_interval) == 0:
                    self._log(f"Keepalive active: {self.operation_count} operations completed")
                
                time.sleep(self.keepalive_interval)
                
            except Exception as e:
                self._log(f"Keepalive error: {e}")
                # Clear any corrupted CUDA state
                torch.cuda.empty_cache()
                time.sleep(1)  # Wait longer after errors
    
    def start(self) -> None:
        """Start the GPU keepalive process."""
        if self.running:
            self._log("Keepalive already running")
            return
        
        self.running = True
        self._thread = threading.Thread(target=self._keepalive_loop, daemon=True)
        self._thread.start()
        
        self._log("GPU keepalive started - RTX will maintain P0 state")
    
    def stop(self) -> None:
        """Stop the GPU keepalive process."""
        if not self.running:
            return
        
        self.running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2)
        
        # Clean up CUDA resources
        torch.cuda.empty_cache()
        
        self._log(f"GPU keepalive stopped after {self.operation_count} operations")
    
    def pause(self) -> None:
        """Temporarily pause keepalive operations."""
        self.paused = True
        self._log("Keepalive paused")
    
    def resume(self) -> None:
        """Resume keepalive operations."""
        self.paused = False
        self._log("Keepalive resumed")
    
    @contextmanager
    def inference_mode(self):
        """Context manager to pause keepalive during active inference."""
        self.generation_active = True
        try:
            yield
        finally:
            self.generation_active = False
    
    def get_stats(self) -> dict:
        """Get keepalive statistics and GPU information."""
        gpu_name = torch.cuda.get_device_name(self.device)
        memory_allocated = torch.cuda.memory_allocated(self.device) / 1024**3
        memory_cached = torch.cuda.memory_reserved(self.device) / 1024**3
        temperature = self._get_gpu_temperature()
        
        return {
            "gpu_name": gpu_name,
            "device_id": self.device.index,
            "running": self.running,
            "paused": self.paused,
            "operation_count": self.operation_count,
            "memory_allocated_gb": round(memory_allocated, 2),
            "memory_cached_gb": round(memory_cached, 2),
            "temperature_celsius": temperature,
            "thermal_protection": self.auto_thermal_protection
        }


def setup_signal_handlers(keepalive: GPUKeepalive) -> None:
    """Setup signal handlers for clean shutdown."""
    def signal_handler(signum, frame):
        print(f"\nReceived signal {signum}, shutting down GPU keepalive...")
        keepalive.stop()
        sys.exit(0)
    
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)


# Quick start functions for simple use cases
def start_keepalive(device_id: int = 0, debug: bool = False) -> GPUKeepalive:
    """Quick start function - creates and starts keepalive."""
    keepalive = GPUKeepalive(device_id=device_id, debug=debug)
    keepalive.start()
    setup_signal_handlers(keepalive)
    return keepalive


def stop_keepalive(keepalive: GPUKeepalive) -> None:
    """Quick stop function."""
    keepalive.stop()


# Example usage and testing
if __name__ == "__main__":
    print("GPU Keepalive - RTX P-State Management")
    print("=" * 40)
    
    if not torch.cuda.is_available():
        print("ERROR: CUDA not available")
        sys.exit(1)
    
    # Display GPU information
    gpu_count = torch.cuda.device_count()
    print(f"Found {gpu_count} CUDA GPU(s):")
    for i in range(gpu_count):
        name = torch.cuda.get_device_name(i)
        props = torch.cuda.get_device_properties(i)
        memory_gb = props.total_memory / 1024**3
        print(f"  GPU {i}: {name} ({memory_gb:.1f} GB VRAM)")
    
    # Start keepalive on primary GPU
    print(f"\nStarting keepalive on GPU 0...")
    keepalive = start_keepalive(device_id=0, debug=True)
    
    try:
        # Simulate inference workload
        print("Simulating inference workload...")
        print("GPU will maintain P0 state during idle periods")
        print("Press Ctrl+C to stop")
        
        # Example of using inference mode context manager
        for i in range(5):
            time.sleep(2)
            with keepalive.inference_mode():
                # Simulate actual inference
                print(f"Inference batch {i+1}/5")
                time.sleep(1)
        
        # Keep running for monitoring
        while True:
            time.sleep(10)
            stats = keepalive.get_stats()
            print(f"Stats: {stats['operation_count']} ops, "
                  f"{stats['memory_allocated_gb']:.1f}GB allocated, "
                  f"temp: {stats['temperature_celsius']}°C")
    
    except KeyboardInterrupt:
        pass
    finally:
        keepalive.stop()
        print("GPU Keepalive demo completed")