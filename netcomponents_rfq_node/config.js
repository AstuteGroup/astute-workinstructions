/**
 * Configuration for NetComponents RFQ automation.
 * Credentials loaded from environment variables.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// =============================================================================
// Credentials (set via environment variables)
// =============================================================================
const NETCOMPONENTS_ACCOUNT = process.env.NETCOMPONENTS_ACCOUNT || '';
const NETCOMPONENTS_USERNAME = process.env.NETCOMPONENTS_USERNAME || '';
const NETCOMPONENTS_PASSWORD = process.env.NETCOMPONENTS_PASSWORD || '';

// =============================================================================
// URLs
// =============================================================================
const BASE_URL = 'https://www.netcomponents.com';
const LOGIN_URL = `${BASE_URL}/login`;
const SEARCH_URL = `${BASE_URL}/search`;

// =============================================================================
// Rate Limiting & Delays (milliseconds)
// =============================================================================
const SEARCH_DELAY = 2000;
const RFQ_DELAY = 1500;
const PAGE_LOAD_TIMEOUT = 30000;
const LOGIN_TIMEOUT = 60000;

// =============================================================================
// Supplier Selection
// =============================================================================
const MAX_SUPPLIERS_PER_REGION = 3;

const AMERICAS_COUNTRIES = new Set([
    'united states', 'usa', 'us', 'u.s.a.', 'u.s.',
    'canada', 'ca',
    'mexico', 'mx',
    'brazil', 'br',
    'argentina', 'ar',
    'chile', 'cl',
    'colombia', 'co',
    'peru', 'pe',
]);

const EUROPE_COUNTRIES = new Set([
    'united kingdom', 'uk', 'u.k.', 'great britain', 'gb',
    'germany', 'de', 'deutschland',
    'france', 'fr',
    'italy', 'it',
    'spain', 'es',
    'netherlands', 'nl', 'holland',
    'belgium', 'be',
    'switzerland', 'ch',
    'austria', 'at',
    'sweden', 'se',
    'denmark', 'dk',
    'norway', 'no',
    'finland', 'fi',
    'poland', 'pl',
    'ireland', 'ie',
    'portugal', 'pt',
    'czech republic', 'cz',
    'hungary', 'hu',
]);

// =============================================================================
// CSS Selectors (discovered from live site exploration)
// =============================================================================
const SELECTORS = {
    // Login modal (appears as overlay on homepage)
    login_link: 'a:has-text("Login")',
    login_account: '#AccountNumber',
    login_username: '#UserName',
    login_password: '#Password',
    login_remember: '#RememberMe',
    login_submit: 'button[type="submit"], .btn-primary',
    login_success: '.user-menu, .logged-in, a:has-text("Logout")',

    // Search (homepage "Sponsored Live Part Search")
    search_input: 'input[name="PartsSearched[0].PartNumber"]',
    search_submit: 'button[type="submit"], .btn-primary',
    search_results: 'table',
    search_no_results: ':has-text("No results")',

    // Results table (columns: Part#, Qty, Description, Updated, Price, Supplier)
    result_table: 'table',
    result_rows: 'table tbody tr, table tr:not(:first-child)',
    result_checkbox: 'input[type="checkbox"]',
    // Column indices (0-based) - to be verified
    col_part_number: 0,
    col_qty: 1,
    col_description: 2,
    col_updated: 3,
    col_price: 4,
    col_supplier: 5,

    // RFQ form (to be discovered after login)
    rfq_quantity: '#rfq-quantity',
    rfq_target_price: '#rfq-target-price',
    rfq_submit: '#rfq-submit',
    rfq_success: '.rfq-confirmation',
};

// =============================================================================
// Paths
// =============================================================================
const PROJECT_ROOT = __dirname;
const SESSION_DIR = path.join(PROJECT_ROOT, '.session');
const COOKIES_FILE = path.join(SESSION_DIR, 'cookies.json');
const SCREENSHOTS_DIR = path.join(PROJECT_ROOT, 'screenshots');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');

// =============================================================================
// Helper Functions
// =============================================================================

function validateCredentials() {
    if (!NETCOMPONENTS_ACCOUNT) {
        console.error('Error: NETCOMPONENTS_ACCOUNT not set');
        return false;
    }
    if (!NETCOMPONENTS_USERNAME) {
        console.error('Error: NETCOMPONENTS_USERNAME not set');
        return false;
    }
    if (!NETCOMPONENTS_PASSWORD) {
        console.error('Error: NETCOMPONENTS_PASSWORD not set');
        return false;
    }
    return true;
}

function getRegion(country) {
    const countryLower = country.toLowerCase().trim();

    if (AMERICAS_COUNTRIES.has(countryLower)) return 'americas';
    if (EUROPE_COUNTRIES.has(countryLower)) return 'europe';

    // Fuzzy match
    for (const c of AMERICAS_COUNTRIES) {
        if (c.includes(countryLower) || countryLower.includes(c)) return 'americas';
    }
    for (const c of EUROPE_COUNTRIES) {
        if (c.includes(countryLower) || countryLower.includes(c)) return 'europe';
    }

    return 'other';
}

module.exports = {
    NETCOMPONENTS_ACCOUNT,
    NETCOMPONENTS_USERNAME,
    NETCOMPONENTS_PASSWORD,
    BASE_URL,
    LOGIN_URL,
    SEARCH_URL,
    SEARCH_DELAY,
    RFQ_DELAY,
    PAGE_LOAD_TIMEOUT,
    LOGIN_TIMEOUT,
    MAX_SUPPLIERS_PER_REGION,
    SELECTORS,
    PROJECT_ROOT,
    SESSION_DIR,
    COOKIES_FILE,
    SCREENSHOTS_DIR,
    OUTPUT_DIR,
    validateCredentials,
    getRegion,
};
