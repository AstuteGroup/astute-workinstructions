"""
Configuration for NetComponents RFQ automation
"""
import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env from node directory (shared credentials)
env_path = Path(__file__).parent.parent / 'node' / '.env'
load_dotenv(env_path)

BASE_URL = "https://www.netcomponents.com"

NETCOMPONENTS_ACCOUNT = os.getenv('NETCOMPONENTS_ACCOUNT', '')
NETCOMPONENTS_USERNAME = os.getenv('NETCOMPONENTS_USERNAME', '')
NETCOMPONENTS_PASSWORD = os.getenv('NETCOMPONENTS_PASSWORD', '')

# Supplier filtering
MAX_SUPPLIERS_PER_REGION = 3
FRANCHISED_NAMES = [
    'mouser', 'digikey', 'arrow', 'avnet', 'newark',
    'element14', 'farnell', 'future', 'rochester', 'tti', 'symmetry'
]

# Paths
SCREENSHOTS_DIR = Path(__file__).parent / 'screenshots'
SCREENSHOTS_DIR.mkdir(exist_ok=True)
