import Cookies from 'js-cookie';
import { BOT_VERSION_CONFIG } from '@/constants/bot-version';
// Relative, not `@/app/...`: jest's moduleNameMapper aliases one directory at a
// time and has no `@/app/` entry.
import { LANGUAGE_STORAGE_KEY } from '../app/seed-translations';

/**
 * Storage migration hook.
 *
 * The original implementation cleared the entire browser storage whenever the
 * bot version was missing or changed. That destroys the user's normal DBot
 * configuration, Analyzer bridge state, selected market, locked signal, and
 * account/session data. TrapKid is a persistent web app, so a version check must
 * never wipe application state implicitly.
 */
const clearLocalStorage = (): void => {
    // Intentionally do not clear storage. Keep this function as a compatibility
    // hook for callers that expect a migration step.
    return;
};

/**
 * Clears all cookies for the current domain and parent domains
 */
const clearCookies = (): void => {
    try {
        // Get all cookies
        const cookies = document.cookie.split(';');

        // Clear each cookie for different domain variations
        const domains = [`.${document.domain.split('.').slice(-2).join('.')}`, `.${document.domain}`, document.domain];

        const paths = ['/', window.location.pathname.split('/', 2)[1] || ''];

        cookies.forEach(cookie => {
            const cookieName = cookie.split('=')[0].trim();
            if (cookieName) {
                // Remove cookie for different domain and path combinations
                domains.forEach(domain => {
                    paths.forEach(path => {
                        Cookies.remove(cookieName, { domain, path });
                    });
                });
                // Also try removing without domain/path
                Cookies.remove(cookieName);
            }
        });
    } catch (error) {
        console.error('Error clearing cookies:', error);
    }
};

/**
 * Sets the bot version in localStorage to prevent infinite clearing
 */
const setBotVersion = (): void => {
    try {
        localStorage.setItem(BOT_VERSION_CONFIG.STORAGE_KEY, BOT_VERSION_CONFIG.REQUIRED_VERSION.toString());
    } catch (error) {
        console.error('Error setting bot version:', error);
    }
};

/**
 * Checks if the current bot version matches the required version
 * @returns true if version matches or is not set, false if version is different
 */
const isVersionValid = (): boolean => {
    try {
        const currentVersion = localStorage.getItem(BOT_VERSION_CONFIG.STORAGE_KEY);

        // If no version is set, consider it invalid (needs clearing)
        if (currentVersion === null) {
            return false;
        }

        // Parse the version and check if it matches
        const versionNumber = parseInt(currentVersion, 10);
        return versionNumber === BOT_VERSION_CONFIG.REQUIRED_VERSION;
    } catch (error) {
        console.error('Error checking bot version:', error);
        return false;
    }
};

/**
 * Performs version check and clears storage if necessary
 * This function should be called at the very beginning of app initialization
 * before any other localStorage or cookie operations
 */
export const performVersionCheck = (): void => {
    console.log('Performing bot version check...');

    if (!isVersionValid()) {
        console.log('Bot version mismatch or not set. Clearing localStorage and cookies...');

        // Do not wipe user/application state during a normal version migration.
        // In particular, preserve Analyzer bridge state, bot settings and login.
        clearLocalStorage();

        // Keep the current session/configuration and just advance the stored version.
        setBotVersion();

        console.log('Bot version migrated without clearing user configuration:', BOT_VERSION_CONFIG.REQUIRED_VERSION);
    } else {
        console.log('Bot version is valid:', BOT_VERSION_CONFIG.REQUIRED_VERSION);
    }
};
