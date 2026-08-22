"""Minimal Ollama HTTP client for the dashboard's interactive Grill Me / Grill With
Docs sessions -- mirrors src/ollama-http.js's approach (same OLLAMA_URL/LOCAL_MODEL env
vars) but in Python since these are synchronous, per-click calls made directly from the
Flask dashboard process, not routed through the Node pipeline.
"""
import json
import os
import urllib.request

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
# No hardcoded model tag fallback -- see src/local-client.js's matching comment
# (2026-08-22, Grimmethy: "models should be fully interchangeable and their names should
# not be hardcoded anywhere"). An unset LOCAL_MODEL surfaces as a real Ollama "model not
# found" error instead of a guessed name.
MODEL = os.environ.get("LOCAL_MODEL")


def generate(prompt: str, think: bool = False, temperature: float = 0.4, num_predict: int = 900) -> dict:
    """POSTs to Ollama's /api/generate. Returns {"response": str, "thinking": str}."""
    body = {
        "model": MODEL,
        "prompt": prompt,
        "think": think,
        "stream": False,
        "options": {"temperature": temperature, "num_predict": num_predict, "num_ctx": 8192},
    }
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=240) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return {"response": data.get("response", ""), "thinking": data.get("thinking", "")}