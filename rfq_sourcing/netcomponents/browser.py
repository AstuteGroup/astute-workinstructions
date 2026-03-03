"""
Browser session management using Playwright async API.
Handles login, cookie persistence, and multi-tab workers.
"""

import asyncio
import json
from pathlib import Path
from datetime import datetime
from playwright.async_api import async_playwright, Browser, BrowserContext, Page

import config


class BrowserSession:
    """
    Manages a Playwright browser session with:
    - Cookie persistence for session reuse
    - Login handling with credential form filling
    - Multi-tab worker support for parallel processing
    """

    def __init__(self, headless: bool = True):
        self.headless = headless
        self._playwright = None
        self._browser: Browser = None
        self._context: BrowserContext = None
        self._main_page: Page = None
        self._worker_pages: dict[str, Page] = {}

    async def __aenter__(self):
        await self.start()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.close()

    async def start(self):
        """Initialize browser and context."""
        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.launch(
            headless=self.headless
        )
        self._context = await self._browser.new_context(
            viewport={"width": 1280, "height": 800},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        )
        self._main_page = await self._context.new_page()

        # Load saved cookies if available
        await self._load_cookies()

    async def close(self):
        """Save cookies and close browser."""
        if self._context:
            await self._save_cookies()

        # Close all worker pages
        for page in self._worker_pages.values():
            await page.close()
        self._worker_pages.clear()

        if self._browser:
            await self._browser.close()
        if self._playwright:
            await self._playwright.stop()

    async def _load_cookies(self):
        """Load cookies from file if they exist."""
        if config.COOKIES_FILE.exists():
            try:
                cookies = json.loads(config.COOKIES_FILE.read_text())
                await self._context.add_cookies(cookies)
                print(f"Loaded {len(cookies)} cookies from session file")
            except (json.JSONDecodeError, Exception) as e:
                print(f"Warning: Could not load cookies: {e}")

    async def _save_cookies(self):
        """Save current cookies to file."""
        try:
            cookies = await self._context.cookies()
            config.COOKIES_FILE.write_text(json.dumps(cookies, indent=2))
            print(f"Saved {len(cookies)} cookies to session file")
        except Exception as e:
            print(f"Warning: Could not save cookies: {e}")

    async def _is_logged_in(self) -> bool:
        """Check if currently logged in by looking for success indicator."""
        try:
            await self._main_page.goto(config.BASE_URL, timeout=config.PAGE_LOAD_TIMEOUT)
            login_indicator = await self._main_page.query_selector(
                config.SELECTORS["login_success"]
            )
            return login_indicator is not None
        except Exception as e:
            print(f"Error checking login status: {e}")
            return False

    async def login(self) -> bool:
        """
        Log in to NetComponents if not already logged in.
        Returns True on success, False on failure.
        """
        # Check if already logged in via cookies
        if await self._is_logged_in():
            print("Already logged in (session restored from cookies)")
            return True

        print("Logging in to NetComponents...")

        if not config.validate_credentials():
            return False

        try:
            # Navigate to login page
            await self._main_page.goto(config.LOGIN_URL, timeout=config.PAGE_LOAD_TIMEOUT)

            # Fill account number
            account_field = await self._main_page.wait_for_selector(
                config.SELECTORS["login_account"],
                timeout=config.LOGIN_TIMEOUT
            )
            await account_field.fill(config.NETCOMPONENTS_ACCOUNT)

            # Fill username
            username_field = await self._main_page.wait_for_selector(
                config.SELECTORS["login_username"],
                timeout=config.LOGIN_TIMEOUT
            )
            await username_field.fill(config.NETCOMPONENTS_USERNAME)

            # Fill password
            password_field = await self._main_page.wait_for_selector(
                config.SELECTORS["login_password"],
                timeout=config.LOGIN_TIMEOUT
            )
            await password_field.fill(config.NETCOMPONENTS_PASSWORD)

            # Submit login form
            submit_button = await self._main_page.wait_for_selector(
                config.SELECTORS["login_submit"],
                timeout=config.LOGIN_TIMEOUT
            )
            await submit_button.click()

            # Wait for login success indicator
            await self._main_page.wait_for_selector(
                config.SELECTORS["login_success"],
                timeout=config.LOGIN_TIMEOUT
            )

            print("Login successful")
            await self._save_cookies()
            return True

        except Exception as e:
            print(f"Login failed: {e}")
            await self.screenshot("login_failure")
            return False

    async def new_worker_page(self, worker_id: str) -> Page:
        """
        Create a new browser tab for a worker.
        Shares the authenticated context with main page.
        """
        if worker_id in self._worker_pages:
            return self._worker_pages[worker_id]

        page = await self._context.new_page()
        self._worker_pages[worker_id] = page
        print(f"Created worker page: {worker_id}")
        return page

    async def close_worker_page(self, worker_id: str):
        """Close a specific worker page."""
        if worker_id in self._worker_pages:
            await self._worker_pages[worker_id].close()
            del self._worker_pages[worker_id]
            print(f"Closed worker page: {worker_id}")

    @property
    def page(self) -> Page:
        """Get the main page."""
        return self._main_page

    async def screenshot(self, name: str, page: Page = None):
        """
        Take a screenshot for debugging.
        Args:
            name: Base name for the screenshot file
            page: Page to screenshot (defaults to main page)
        """
        target_page = page or self._main_page
        if not target_page:
            return

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = config.SCREENSHOTS_DIR / f"{name}_{timestamp}.png"

        try:
            await target_page.screenshot(path=str(filename), full_page=True)
            print(f"Screenshot saved: {filename}")
        except Exception as e:
            print(f"Warning: Could not save screenshot: {e}")

    async def get_page_content(self, page: Page = None) -> str:
        """Get the HTML content of a page."""
        target_page = page or self._main_page
        return await target_page.content()
