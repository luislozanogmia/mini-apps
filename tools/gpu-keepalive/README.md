# GPU Keepalive

An experimental helper that runs small background CUDA operations to reduce idle NVIDIA GPU power-state transitions. Requires a compatible NVIDIA GPU, drivers, and CUDA-enabled PyTorch. Results depend on hardware.

From this directory, use your existing PyTorch environment:

```python
from gpu_keepalive import GPUKeepalive

keepalive = GPUKeepalive(debug=True)
keepalive.start()
try:
    with keepalive.inference_mode():
        pass  # Run your inference here.
finally:
    keepalive.stop()
```

`setup.py` is an optional legacy interactive setup utility, not Python package metadata. It installs dependencies, inspects your GPU, and writes an example server. Read it before running; it installs more packages than the core helper requires.

The helper includes optional thermal protection. Monitor temperatures and power consumption when experimenting. This import has received syntax checks, not a new GPU hardware validation.

MIT; see [LICENSE](LICENSE).
