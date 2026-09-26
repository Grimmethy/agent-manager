import sys
from pathlib import Path

# Make `app` (python/dashboard/app.py) importable when pytest is run
# from the tests/ directory or the repository root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
