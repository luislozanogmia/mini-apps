#!/usr/bin/env python3
"""
GPU Keepalive Setup Script
==========================

Automatically detects GPU configuration and recommends optimal models
for local LLM inference based on available VRAM.
"""

import sys
import subprocess
import importlib.util
from pathlib import Path


def install_package(package):
    """Install package using pip."""
    subprocess.check_call([sys.executable, "-m", "pip", "install", package])


def ensure_dependencies():
    """Ensure all required dependencies are installed."""
    requirements = [
        "torch>=2.0.0",
        "fastapi>=0.68.0",
        "uvicorn>=0.15.0",
        "transformers>=4.21.0",
        "accelerate>=0.20.0",
        "pydantic>=1.8.0",
        "pynvml",  # For GPU monitoring
    ]
    
    print("Checking dependencies...")
    missing = []
    
    for req in requirements:
        package_name = req.split(">=")[0].split("==")[0]
        spec = importlib.util.find_spec(package_name)
        if spec is None:
            missing.append(req)
    
    if missing:
        print(f"Installing missing dependencies: {', '.join(missing)}")
        for package in missing:
            try:
                install_package(package)
                print(f"✅ Installed {package}")
            except subprocess.CalledProcessError:
                print(f"❌ Failed to install {package}")
                return False
    else:
        print("✅ All dependencies satisfied")
    
    return True


def detect_gpu_info():
    """Detect GPU information and calculate VRAM."""
    try:
        import torch
        if not torch.cuda.is_available():
            return None, 0, "CUDA not available"
        
        gpu_count = torch.cuda.device_count()
        gpu_info = []
        
        for i in range(gpu_count):
            name = torch.cuda.get_device_name(i)
            props = torch.cuda.get_device_properties(i)
            vram_gb = props.total_memory / (1024**3)
            gpu_info.append({
                'id': i,
                'name': name,
                'vram_gb': vram_gb,
                'compute_capability': f"{props.major}.{props.minor}"
            })
        
        return gpu_info, gpu_count, None
    
    except ImportError:
        return None, 0, "PyTorch not installed"
    except Exception as e:
        return None, 0, str(e)


def get_model_recommendations(vram_gb):
    """Generate model recommendations based on available VRAM."""
    
    # Model database with realistic VRAM requirements
    # Format: (name, params, fp16_gb, 4bit_gb, description)
    models = [
        ("TinyLlama-1.1B", "1B", 2.2, 1.1, "Ultra-lightweight, good for testing"),
        ("Qwen2.5-3B-Instruct", "3B", 6.0, 3.0, "Excellent quality/size balance"),
        ("Llama-3.2-3B-Instruct", "3B", 6.2, 3.1, "Meta's efficient 3B model"),
        ("Qwen2.5-7B-Instruct", "7B", 14.0, 7.0, "High-quality 7B model"),
        ("Llama-3.1-8B-Instruct", "8B", 16.0, 8.0, "Strong reasoning capabilities"),
        ("Mistral-NeMo-12B", "12B", 24.0, 12.0, "NVIDIA collab, 128k context, Apache 2.0"),
        ("gpt-oss-20b", "21B", 32.0, 16.0, "OpenAI's open MoE model (Aug 2025)"),
        ("Mixtral-8x7B-Instruct", "47B", 90.0, 45.0, "Mixture of experts, excellent quality"),
        ("Llama-3.1-Nemotron-70B", "70B", 140.0, 70.0, "NVIDIA's RLHF-tuned, beats GPT-4o"),
        ("Llama-3.1-70B-Instruct", "70B", 140.0, 70.0, "Meta's flagship 70B model"),
        ("gpt-oss-120b", "117B", 160.0, 80.0, "OpenAI's largest open MoE (Aug 2025)"),
    ]
    
    recommendations = {
        "optimal": [],      # Best fit models (50-65% VRAM usage)
        "conservative": [], # Safe models (30-45% VRAM usage)  
        "aggressive": []    # Tight fit models (70-85% VRAM usage)
    }
    
    for name, params, fp16_req, bit4_req, desc in models:
        # Calculate VRAM percentages for both quantizations
        fp16_percent = (fp16_req / vram_gb) * 100 if vram_gb > 0 else 100
        bit4_percent = (bit4_req / vram_gb) * 100 if vram_gb > 0 else 100
        
        # Conservative recommendations (good safety margin)
        if bit4_percent <= 45:
            recommendations["conservative"].append({
                "name": name, "params": params, "vram_gb": bit4_req, 
                "quant": "4-bit", "usage_percent": bit4_percent, "desc": desc
            })
        if fp16_percent <= 45:
            recommendations["conservative"].append({
                "name": name, "params": params, "vram_gb": fp16_req,
                "quant": "FP16", "usage_percent": fp16_percent, "desc": desc
            })
        
        # Optimal recommendations (balanced performance/safety)
        if 45 < bit4_percent <= 65:
            recommendations["optimal"].append({
                "name": name, "params": params, "vram_gb": bit4_req,
                "quant": "4-bit", "usage_percent": bit4_percent, "desc": desc
            })
        if 45 < fp16_percent <= 65:
            recommendations["optimal"].append({
                "name": name, "params": params, "vram_gb": fp16_req,
                "quant": "FP16", "usage_percent": fp16_percent, "desc": desc
            })
        
        # Aggressive recommendations (maximum model size)
        if 65 < bit4_percent <= 85:
            recommendations["aggressive"].append({
                "name": name, "params": params, "vram_gb": bit4_req,
                "quant": "4-bit", "usage_percent": bit4_percent, "desc": desc
            })
        if 65 < fp16_percent <= 85:
            recommendations["aggressive"].append({
                "name": name, "params": params, "vram_gb": fp16_req,
                "quant": "FP16", "usage_percent": fp16_percent, "desc": desc
            })
    
    # Sort by VRAM usage within each category
    for category in recommendations:
        recommendations[category].sort(key=lambda x: x["usage_percent"])
    
    return recommendations


def print_gpu_analysis():
    """Print comprehensive GPU analysis and recommendations."""
    print("\n" + "="*60)
    print("GPU KEEPALIVE - SYSTEM ANALYSIS")
    print("="*60)
    
    gpu_info, gpu_count, error = detect_gpu_info()
    
    if error:
        print(f"❌ GPU Detection Error: {error}")
        print("\nPlease ensure:")
        print("  1. NVIDIA GPU with CUDA support is installed")
        print("  2. CUDA drivers are properly configured")
        print("  3. PyTorch with CUDA support is installed")
        return False
    
    if gpu_count == 0:
        print("❌ No CUDA GPUs detected")
        return False
    
    print(f"✅ Detected {gpu_count} CUDA GPU(s):")
    
    for gpu in gpu_info:
        print(f"\n🎯 GPU {gpu['id']}: {gpu['name']}")
        print(f"   VRAM: {gpu['vram_gb']:.1f} GB")
        print(f"   Compute: {gpu['compute_capability']}")
        
        # Generate recommendations for this GPU
        vram_gb = gpu['vram_gb']
        recommendations = get_model_recommendations(vram_gb)
        
        print(f"\n📊 MODEL RECOMMENDATIONS FOR {vram_gb:.1f}GB VRAM:")
        print(f"    (Percentages show VRAM usage for model weights)")
        
        # Print optimal recommendations
        if recommendations["optimal"]:
            print(f"\n   🟢 OPTIMAL MODELS (balanced performance/safety):")
            for i, model in enumerate(recommendations["optimal"][:3], 1):
                print(f"      {i}. {model['name']} ({model['quant']})")
                print(f"         └─ {model['vram_gb']:.1f}GB ({model['usage_percent']:.1f}%) - {model['desc']}")
        
        # Print conservative recommendations  
        if recommendations["conservative"]:
            print(f"\n   🔵 CONSERVATIVE MODELS (safe choice, room for growth):")
            for i, model in enumerate(recommendations["conservative"][-2:], 1):  # Show largest conservative options
                print(f"      {i}. {model['name']} ({model['quant']})")
                print(f"         └─ {model['vram_gb']:.1f}GB ({model['usage_percent']:.1f}%) - {model['desc']}")
        
        # Print aggressive recommendations
        if recommendations["aggressive"]:
            print(f"\n   🟡 AGGRESSIVE MODELS (maximum size, tight fit):")
            for i, model in enumerate(recommendations["aggressive"][:2], 1):
                print(f"      {i}. {model['name']} ({model['quant']})")
                print(f"         └─ {model['vram_gb']:.1f}GB ({model['usage_percent']:.1f}%) - {model['desc']}")
        
        if not any(recommendations.values()):
            print(f"\n   ⚠️  Limited options for {vram_gb:.1f}GB VRAM")
            print(f"       Consider models under 2GB or upgrade GPU")
        
        # VRAM allocation guidance
        inference_vram = vram_gb * 0.4  # Conservative estimate
        print(f"\n   📋 VRAM ALLOCATION GUIDANCE:")
        print(f"      • Reserve ~{inference_vram:.1f}GB for inference/KV cache")
        print(f"      • Use remaining ~{vram_gb - inference_vram:.1f}GB for model weights")
        print(f"      • 4-bit quantization halves memory usage vs FP16")
    
    return True


def create_example_server():
    """Create an example server file for quick testing."""
    
    example_code = '''#!/usr/bin/env python3
"""
Example GPU Keepalive Server
============================

Quick test server demonstrating RTX P-state management during LLM inference.
Replace with your actual model loading and inference code.
"""

import time
from gpu_keepalive import GPUKeepalive, setup_signal_handlers

def main():
    print("Starting GPU Keepalive Example Server...")
    
    # Initialize and start keepalive
    keepalive = GPUKeepalive(debug=True)
    keepalive.start()
    setup_signal_handlers(keepalive)
    
    print("GPU Keepalive active - RTX will maintain P0 state")
    print("Load your model and run inference now.")
    print("Press Ctrl+C to stop")
    
    try:
        # Your model loading code goes here
        # model = AutoModelForCausalLM.from_pretrained(...)
        
        # Simulation loop
        while True:
            time.sleep(5)
            
            # Example: pause during inference, resume after
            with keepalive.inference_mode():
                print("Simulating inference... (keepalive paused)")
                time.sleep(2)
            
            # Display stats
            stats = keepalive.get_stats()
            temp_info = f"{stats['temperature_celsius']}C" if stats['temperature_celsius'] else "N/A"
            print(f"Status: {stats['operation_count']} keepalive ops, temp: {temp_info}")
    
    except KeyboardInterrupt:
        print("\\nShutting down...")
    finally:
        keepalive.stop()
        print("GPU Keepalive stopped")

if __name__ == "__main__":
    main()
'''
    
    example_path = Path("example_server.py")
    with open(example_path, 'w', encoding='utf-8') as f:
        f.write(example_code)
    
    print(f"✅ Created {example_path} for quick testing")


def main():
    """Main setup function."""
    print("GPU Keepalive - RTX P-State Management Setup")
    print("=" * 45)
    
    # Step 1: Install dependencies
    if not ensure_dependencies():
        print("❌ Dependency installation failed")
        return 1
    
    # Step 2: Analyze GPU configuration
    if not print_gpu_analysis():
        print("❌ GPU analysis failed")
        return 1
    
    # Step 3: Create example server
    create_example_server()
    
    # Step 4: Installation complete
    print("\n" + "="*60)
    print("🚀 GPU KEEPALIVE SETUP COMPLETE")
    print("="*60)
    print("\n⚠️  RESEARCH & TESTING TOOL")
    print("   Tested primarily on RTX 3070 Laptop (85W)")
    print("   Use for research, demos, and experimentation")
    print("   Validate thoroughly before any production use")
    print("\nNext steps:")
    print("1. Test: python example_server.py")
    print("2. Experiment: from gpu_keepalive import GPUKeepalive") 
    print("3. Validate: Monitor P-states with nvidia-smi")
    print("\nDocumentation: ../../../README.md")
    print("Issues: Report RTX P-state experiments and results")
    
    return 0


if __name__ == "__main__":
    sys.exit(main())