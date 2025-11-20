// ==================== GLOBAL STATE ====================
let allData = [];
let filteredData = [];
let totalRecords = 0;
let currentPage = 1;
const pageSize = 10;
let totalPages = 1;
let currentJobId = null;
let processingInterval = null;
let youtubeApiReady = false;
let youtubePlayerInstances = {};
let currentSort = { column: 'bayesian_score', direction: 'desc' };
let hasSearched = false;
let currentVideoIndex = {};
let trackedSellers = [];
let selectedSellers = []; // Empty = all sellers

// Per-seller style preferences (stored in localStorage)
const SELLER_STYLE_PREFS_KEY = 'seller_style_preferences';
let sellerStylePreferences = {};
  
function getSellerSelectedStyles(username) {
    if (!sellerStylePreferences || !sellerStylePreferences[username]) {
        return null; // null => default (all styles)
    }
    const entry = sellerStylePreferences[username];
    return Array.isArray(entry.selectedStyles) ? entry.selectedStyles : null;
}

// OAuth State
let oauthUser = null;
let userAccessToken = null;

// View State
let currentView = 'sellers'; // 'sellers', 'collection', 'wantlist'
let userWantlistIds = new Set(); // Cache of release IDs in user's wantlist
let cachedCollectionData = null; // Cache enriched collection data
let cachedWantlistData = null; // Cache enriched wantlist data
let lastCollectionIds = new Set(); // Track collection release IDs
let lastWantlistIds = new Set(); // Track wantlist release IDs

// ==================== CACHE PERSISTENCE ====================
// Save cache to localStorage
function saveCollectionCache() {
    if (cachedCollectionData && oauthUser) {
        try {
            localStorage.setItem(`collection_cache_${oauthUser.username}`, JSON.stringify(cachedCollectionData));
            localStorage.setItem(`collection_ids_${oauthUser.username}`, JSON.stringify([...lastCollectionIds]));
        } catch (e) {
            console.error('Failed to save collection cache:', e);
        }
    }
}

function saveWantlistCache() {
    if (cachedWantlistData && oauthUser) {
        try {
            localStorage.setItem(`wantlist_cache_${oauthUser.username}`, JSON.stringify(cachedWantlistData));
            localStorage.setItem(`wantlist_ids_${oauthUser.username}`, JSON.stringify([...lastWantlistIds]));
        } catch (e) {
            console.error('Failed to save wantlist cache:', e);
        }
    }
}

// Load cache from localStorage
function loadCollectionCache() {
    if (oauthUser) {
        try {
            const cachedData = localStorage.getItem(`collection_cache_${oauthUser.username}`);
            const cachedIds = localStorage.getItem(`collection_ids_${oauthUser.username}`);
            if (cachedData && cachedIds) {
                cachedCollectionData = JSON.parse(cachedData);
                lastCollectionIds = new Set(JSON.parse(cachedIds));
                console.log(`Loaded collection cache: ${cachedCollectionData.length} items`);
            }
        } catch (e) {
            console.error('Failed to load collection cache:', e);
        }
    }
}

function loadWantlistCache() {
    if (oauthUser) {
        try {
            const cachedData = localStorage.getItem(`wantlist_cache_${oauthUser.username}`);
            const cachedIds = localStorage.getItem(`wantlist_ids_${oauthUser.username}`);
            if (cachedData && cachedIds) {
                cachedWantlistData = JSON.parse(cachedData);
                lastWantlistIds = new Set(JSON.parse(cachedIds));
                console.log(`Loaded wantlist cache: ${cachedWantlistData.length} items`);
            }
        } catch (e) {
            console.error('Failed to load wantlist cache:', e);
        }
    }
}

// Clear cache for a user
function clearUserCache() {
    if (oauthUser) {
        localStorage.removeItem(`collection_cache_${oauthUser.username}`);
        localStorage.removeItem(`collection_ids_${oauthUser.username}`);
        localStorage.removeItem(`wantlist_cache_${oauthUser.username}`);
        localStorage.removeItem(`wantlist_ids_${oauthUser.username}`);
    }
    cachedCollectionData = null;
    cachedWantlistData = null;
    lastCollectionIds.clear();
    lastWantlistIds.clear();
}

// Normalize a Discogs inventory listing to a compact format for storage
function normalizeListingForInventory(listing) {
    if (!listing) return null;

    // If it's already in compact form, return as-is
    if (typeof listing.releaseId !== 'undefined') {
        return {
            releaseId: listing.releaseId,
            artist: listing.artist || 'Unknown Artist',
            title: listing.title || 'Unknown Title',
            price: typeof listing.price === 'number' ? listing.price : parseFloat(listing.price || 0) || 0,
            condition: listing.condition || ''
        };
    }

    const release = listing.release || {};
    const priceRaw = (listing.price && typeof listing.price === 'object')
        ? listing.price.value
        : listing.price;

    const price = parseFloat(priceRaw || 0) || 0;
    const condition =
        listing.condition ||
        listing.media_condition ||
        listing.item_condition ||
        listing.condition_grade ||
        '';

    return {
        releaseId: release.id,
        artist: release.artist || (release.artists && release.artists[0] && release.artists[0].name) || 'Unknown Artist',
        title: release.title || 'Unknown Title',
        price: price,
        condition: condition
    };
}

// Helper to read inventory items in either legacy (full Discogs listing)
// or compact normalized format
function getListingInfoFromInventory(listing) {
    if (!listing) return null;

    if (typeof listing.releaseId !== 'undefined') {
        return {
            releaseId: listing.releaseId,
            artist: listing.artist || 'Unknown Artist',
            title: listing.title || 'Unknown Title',
            price: typeof listing.price === 'number' ? listing.price : parseFloat(listing.price || 0) || 0,
            condition: listing.condition || ''
        };
    }

    return normalizeListingForInventory(listing);
}

// IndexedDB configuration for larger cached payloads
const DB_NAME = 'discogsSellerTracker';
const DB_VERSION = 1;
const SELLER_STORE = 'sellers';
const SELLER_METADATA_KEY = 'tracked_seller_metadata';
let sellerDBPromise = null;

function getSellerDB() {
    if (!sellerDBPromise) {
        sellerDBPromise = new Promise((resolve, reject) => {
            if (!window.indexedDB) {
                reject(new Error('IndexedDB not supported in this browser.'));
                return;
            }

            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(SELLER_STORE)) {
                    db.createObjectStore(SELLER_STORE, { keyPath: 'username' });
                }
            };

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    return sellerDBPromise;
}

async function getSellerDataFromDB(username) {
    try {
        const db = await getSellerDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(SELLER_STORE, 'readonly');
            const store = tx.objectStore(SELLER_STORE);
            const request = store.get(username);

            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error('Failed to read seller data from IndexedDB:', error);
        return null;
    }
}

async function saveSellerDataToDB(seller) {
    try {
        const db = await getSellerDB();
        const payload = {
            username: seller.username,
            // Always store inventory in compact normalized form
            inventory: Array.isArray(seller.inventory)
                ? seller.inventory.map(normalizeListingForInventory)
                : [],
            releases: seller.releases || []
        };

        await new Promise((resolve, reject) => {
            const tx = db.transaction(SELLER_STORE, 'readwrite');
            const store = tx.objectStore(SELLER_STORE);
            const request = store.put(payload);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error('Failed to save seller data to IndexedDB:', error);
    }
}

async function deleteSellerDataFromDB(username) {
    try {
        const db = await getSellerDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(SELLER_STORE, 'readwrite');
            const store = tx.objectStore(SELLER_STORE);
            const request = store.delete(username);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error('Failed to delete seller data from IndexedDB:', error);
    }
}

// ==================== STORAGE MANAGEMENT ====================
function cleanupLocalStorage() {
    try {
        const keys = Object.keys(localStorage);
        const now = Date.now();
        const MAX_JOB_AGE = 24 * 60 * 60 * 1000; // 24 hours
        let cleaned = 0;
        
        keys.forEach(key => {
            if (key.startsWith('job_')) {
                try {
                    const job = JSON.parse(localStorage.getItem(key));
                    if (job.createdAt && (now - job.createdAt > MAX_JOB_AGE)) {
                        localStorage.removeItem(key);
                        cleaned++;
                    }
                } catch (e) {
                    // Invalid job data, remove it
                    localStorage.removeItem(key);
                    cleaned++;
                }
            }
        });
        
        if (cleaned > 0) {
            console.log(`Cleaned up ${cleaned} old job entries from localStorage`);
        }
    } catch (e) {
        console.error('Failed to clean up old jobs:', e);
    }
}

function aggressiveCleanupLocalStorage() {
    // Emergency cleanup: remove ALL job data
    try {
        const keys = Object.keys(localStorage);
        let cleaned = 0;
        keys.forEach(key => {
            if (key.startsWith('job_')) {
                localStorage.removeItem(key);
                cleaned++;
            }
        });
        console.log(`Emergency cleanup: removed ${cleaned} job entries`);
        return cleaned > 0;
    } catch (e) {
        console.error('Failed aggressive cleanup:', e);
        return false;
    }
}

// One-time compaction of existing seller data in IndexedDB to reduce storage size
async function compactSellerDatabaseIfNeeded() {
    const FLAG_KEY = 'seller_db_compacted_v1';
    if (localStorage.getItem(FLAG_KEY) === 'true') {
        return;
    }

    try {
        const db = await getSellerDB();

        await new Promise((resolve, reject) => {
            const tx = db.transaction(SELLER_STORE, 'readwrite');
            const store = tx.objectStore(SELLER_STORE);
            const request = store.getAll();

            request.onsuccess = () => {
                const sellers = request.result || [];

                sellers.forEach(record => {
                    let changed = false;

                    if (Array.isArray(record.inventory) && record.inventory.length > 0) {
                        const compactInventory = record.inventory
                            .map(normalizeListingForInventory)
                            .filter(item => item && item.releaseId);
                        record.inventory = compactInventory;
                        changed = true;
                    }

                    if (changed) {
                        store.put(record);
                    }
                });
            };

            tx.oncomplete = () => {
                try {
                    localStorage.setItem(FLAG_KEY, 'true');
                } catch (e) {
                    console.warn('Could not persist compaction flag:', e);
                }
                resolve();
            };

            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.error('Failed to compact seller DB:', e);
    }
}

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', async () => {
    // Clean up old job data on startup to free localStorage space
    cleanupLocalStorage();

    // Compact existing IndexedDB data (runs only once per browser)
    await compactSellerDatabaseIfNeeded();
    
    // Load user auth state
    loadOAuthState();
    
    checkCredentials();
    
    // Dark mode toggle
    const darkModeToggle = document.getElementById('darkModeToggle');
    if (localStorage.getItem('darkModeEnabled') === 'true' || !localStorage.getItem('darkModeEnabled')) {
        document.body.classList.add('dark-mode');
    } else {
        document.body.classList.remove('dark-mode');
    }
    
    darkModeToggle.addEventListener('click', () => {
        if (document.body.classList.contains('dark-mode')) {
            document.body.classList.remove('dark-mode');
            localStorage.setItem('darkModeEnabled', 'false');
        } else {
            document.body.classList.add('dark-mode');
            localStorage.setItem('darkModeEnabled', 'true');
        }
    });

    // Load cached filter state
    loadFilterState();
    
    // Initialize multi-select dropdowns
    initMultiSelectDropdowns();

    // Filter change handlers for range inputs (multi-selects handle their own changes)
    document.getElementById('year_range').addEventListener('input', debounce(applyFilters, 500));
    document.getElementById('rating_range').addEventListener('input', debounce(applyFilters, 500));
    document.getElementById('rating_count_range').addEventListener('input', debounce(applyFilters, 500));
    const priceRangeEl = document.getElementById('price_range');
    if (priceRangeEl) priceRangeEl.addEventListener('input', debounce(applyFilters, 500));
    const wantRangeEl = document.getElementById('want_range');
    if (wantRangeEl) wantRangeEl.addEventListener('input', debounce(applyFilters, 500));
    
    // Navbar search
    const navSearch = document.getElementById('navSearchInput');
    if (navSearch) {
        navSearch.addEventListener('input', debounce(() => {
            applyFilters();
        }, 250));
    }

    // Clear all filters button
    const clearAllBtn = document.getElementById('clear-all-filters');
    if (clearAllBtn) {
        clearAllBtn.addEventListener('click', () => {
            clearAllFilters();
        });
    }

    // Mobile filter toggle
    const mobileFiltersToggle = document.getElementById('mobile-filters-toggle');
    const mobileExtraFilters = document.querySelector('.mobile-extra-filters-wrapper');
    if (mobileFiltersToggle && mobileExtraFilters) {
        mobileFiltersToggle.addEventListener('click', () => {
            mobileFiltersToggle.classList.toggle('open');
            mobileExtraFilters.classList.toggle('show');
        });
    }

    // Load seller style preferences
    try {
        const prefsStr = localStorage.getItem(SELLER_STYLE_PREFS_KEY);
        if (prefsStr) {
            sellerStylePreferences = JSON.parse(prefsStr) || {};
        }
    } catch (e) {
        console.warn('Failed to load seller style preferences:', e);
        sellerStylePreferences = {};
    }

    // Load tracked sellers and display
    await loadTrackedSellers();
    checkForStoredJob();
});

function onYouTubeIframeAPIReady() {
    youtubeApiReady = true;
}

// ==================== CREDENTIALS MANAGEMENT ====================
function checkCredentials() {
    const consumerKey = localStorage.getItem('discogs_consumer_key');
    const consumerSecret = localStorage.getItem('discogs_consumer_secret');
    
    if (!consumerKey || !consumerSecret) {
        setTimeout(() => {
            const modal = new bootstrap.Modal(document.getElementById('settingsModal'));
            modal.show();
        }, 500);
    }
}

function openSettings() {
    const modal = new bootstrap.Modal(document.getElementById('settingsModal'));
    document.getElementById('consumerKey').value = localStorage.getItem('discogs_consumer_key') || '';
    document.getElementById('consumerSecret').value = localStorage.getItem('discogs_consumer_secret') || '';
    modal.show();
}

function saveSettings() {
    const consumerKey = document.getElementById('consumerKey').value.trim();
    const consumerSecret = document.getElementById('consumerSecret').value.trim();
    
    if (!consumerKey || !consumerSecret) {
        alert('Please enter both Consumer Key and Consumer Secret');
        return;
    }
    
    localStorage.setItem('discogs_consumer_key', consumerKey);
    localStorage.setItem('discogs_consumer_secret', consumerSecret);
    
    // Track API connection
    if (typeof gtag !== 'undefined') {
        gtag('event', 'api_connected', {
            event_category: 'Discogs API',
            event_label: 'User configured API credentials'
        });
    }
    
    const modal = bootstrap.Modal.getInstance(document.getElementById('settingsModal'));
    modal.hide();
    
    alert('Settings saved successfully!');
}

// ==================== PROFILE & DATA MANAGEMENT ====================
function openProfile() {
    const modal = new bootstrap.Modal(document.getElementById('profileModal'));
    modal.show();
}

async function exportData() {
    try {
        // Get all seller data from IndexedDB
        const db = await getSellerDB();
        const sellersData = await new Promise((resolve, reject) => {
            const tx = db.transaction(SELLER_STORE, 'readonly');
            const store = tx.objectStore(SELLER_STORE);
            const request = store.getAll();
            
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
        
        // Get seller metadata from localStorage
        const metadataStr = localStorage.getItem(SELLER_METADATA_KEY);
        const metadata = metadataStr ? JSON.parse(metadataStr) : [];
        
        // Get settings
        const settings = {
            consumerKey: localStorage.getItem('discogs_consumer_key') || '',
            consumerSecret: localStorage.getItem('discogs_consumer_secret') || '',
            darkModeEnabled: localStorage.getItem('darkModeEnabled') || 'false',
            sellerStylePreferences: (() => {
                try {
                    const prefsStr = localStorage.getItem(SELLER_STYLE_PREFS_KEY);
                    return prefsStr ? JSON.parse(prefsStr) : {};
                } catch (e) {
                    console.warn('Failed to include seller style preferences in export:', e);
                    return {};
                }
            })()
        };
        
        // Combine all data
        const dataToExport = {
            version: '1.0',
            exportDate: new Date().toISOString(),
            sellers: sellersData,
            metadata: metadata,
            settings: settings
        };
        
        // Create download using streaming approach to handle large data
        // Use a helper function that creates JSON in chunks to avoid string length limits
        const chunks = [];
        
        // Helper function to safely stringify large objects
        function stringifyLargeObject(obj) {
            try {
                // First try with pretty-printing
                return JSON.stringify(obj, null, 2);
            } catch (e) {
                if (e.message && e.message.includes('string length')) {
                    // If that fails, try without pretty-printing (smaller)
                    try {
                        return JSON.stringify(obj);
                    } catch (e2) {
                        // If still too large, use streaming approach
                        return null;
                    }
                }
                throw e;
            }
        }
        
        let dataStr = stringifyLargeObject(dataToExport);
        
        // If stringify failed due to size, use streaming JSON writer
        if (dataStr === null) {
            // Stream JSON creation in chunks to avoid string length limits
            const encoder = new TextEncoder();
            
            // Helper to safely stringify individual items
            function safeStringify(obj) {
                try {
                    return JSON.stringify(obj);
                } catch (e) {
                    // If even a single item is too large, return a placeholder
                    console.warn('Item too large to stringify, using placeholder:', e);
                    return JSON.stringify({ error: 'Item too large to export', size: 'exceeded' });
                }
            }
            
            chunks.push(encoder.encode('{\n'));
            chunks.push(encoder.encode('  "version": "1.0",\n'));
            chunks.push(encoder.encode(`  "exportDate": "${dataToExport.exportDate}",\n`));
            chunks.push(encoder.encode('  "sellers": [\n'));
            
            // Stream sellers array one at a time
            for (let i = 0; i < sellersData.length; i++) {
                const sellerStr = safeStringify(sellersData[i]);
                // Encode parts separately to avoid string concatenation issues
                chunks.push(encoder.encode('    '));
                chunks.push(encoder.encode(sellerStr));
                if (i < sellersData.length - 1) {
                    chunks.push(encoder.encode(',\n'));
                } else {
                    chunks.push(encoder.encode('\n'));
                }
            }
            
            chunks.push(encoder.encode('  ],\n'));
            chunks.push(encoder.encode('  "metadata": '));
            chunks.push(encoder.encode(safeStringify(metadata)));
            chunks.push(encoder.encode(',\n'));
            chunks.push(encoder.encode('  "settings": '));
            chunks.push(encoder.encode(safeStringify(settings)));
            chunks.push(encoder.encode('\n'));
            chunks.push(encoder.encode('}'));
            
            // Create blob from chunks
            const dataBlob = new Blob(chunks, { type: 'application/json' });
            const url = URL.createObjectURL(dataBlob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `discogs-trackr-backup-${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        } else {
            // Normal path for smaller data
            const dataBlob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(dataBlob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `discogs-trackr-backup-${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        }
        
        alert('Data exported successfully!');
    } catch (error) {
        console.error('Export failed:', error);
        alert('Failed to export data: ' + error.message);
    }
}

async function handleImportFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    if (!confirm('This will replace all your current data. Are you sure you want to continue?')) {
        event.target.value = ''; // Reset file input
        return;
    }
    
    try {
        const text = await file.text();
        const importData = JSON.parse(text);
        
        // Validate import data structure
        if (!importData.version || !importData.sellers || !importData.metadata || !importData.settings) {
            throw new Error('Invalid backup file format');
        }
        
        // Import sellers data to IndexedDB
        const db = await getSellerDB();
        
        // First, clear existing data
        await new Promise((resolve, reject) => {
            const tx = db.transaction(SELLER_STORE, 'readwrite');
            const store = tx.objectStore(SELLER_STORE);
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
            tx.onerror = () => reject(tx.error);
        });
        
        // Then, add imported sellers
        if (importData.sellers && importData.sellers.length > 0) {
            await new Promise((resolve, reject) => {
                const tx = db.transaction(SELLER_STORE, 'readwrite');
                const store = tx.objectStore(SELLER_STORE);
                
                const promises = importData.sellers.map(seller => {
                    return new Promise((resolveItem, rejectItem) => {
                        const request = store.put({
                            username: seller.username,
                            // Normalize imported inventory to compact form
                            inventory: Array.isArray(seller.inventory)
                                ? seller.inventory.map(normalizeListingForInventory)
                                : [],
                            releases: seller.releases || []
                        });
                        request.onsuccess = () => resolveItem();
                        request.onerror = () => rejectItem(request.error);
                    });
                });
                
                Promise.all(promises).then(() => {
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => reject(tx.error);
                }).catch(reject);
            });
        }
        
        // Import metadata to localStorage
        if (importData.metadata && Array.isArray(importData.metadata)) {
            localStorage.setItem(SELLER_METADATA_KEY, JSON.stringify(importData.metadata));
        }
        
        // Import settings
        if (importData.settings) {
            if (importData.settings.consumerKey) {
                localStorage.setItem('discogs_consumer_key', importData.settings.consumerKey);
            }
            if (importData.settings.consumerSecret) {
                localStorage.setItem('discogs_consumer_secret', importData.settings.consumerSecret);
            }
            if (importData.settings.darkModeEnabled !== undefined) {
                localStorage.setItem('darkModeEnabled', importData.settings.darkModeEnabled);
                // Apply dark mode if needed
                if (importData.settings.darkModeEnabled === 'true') {
                    document.body.classList.add('dark-mode');
                } else {
                    document.body.classList.remove('dark-mode');
                }
            }
            if (importData.settings.sellerStylePreferences) {
                try {
                    sellerStylePreferences = importData.settings.sellerStylePreferences || {};
                    localStorage.setItem(SELLER_STYLE_PREFS_KEY, JSON.stringify(sellerStylePreferences));
                } catch (e) {
                    console.warn('Failed to import seller style preferences:', e);
                    sellerStylePreferences = {};
                }
            }
        }
        
        // Reload tracked sellers
        await loadTrackedSellers();
        
        // Close modal
        const modal = bootstrap.Modal.getInstance(document.getElementById('profileModal'));
        modal.hide();
        
        // Reset file input
        event.target.value = '';
        
        alert('Data imported successfully! Your page will refresh to show the imported data.');
        // Optionally reload the page to ensure everything is synced
        window.location.reload();
    } catch (error) {
        console.error('Import failed:', error);
        alert('Failed to import data: ' + error.message);
        event.target.value = ''; // Reset file input
    }
}

// ==================== SELLER MANAGEMENT ====================
async function loadTrackedSellers() {
    try {
        let metadata = [];
        const metadataStr = localStorage.getItem(SELLER_METADATA_KEY);

        if (metadataStr) {
            metadata = JSON.parse(metadataStr);
        } else {
            // Migration path from legacy localStorage structure
            const legacyStr = localStorage.getItem('tracked_sellers');
            if (legacyStr) {
                try {
                    const legacyData = JSON.parse(legacyStr);
                    if (Array.isArray(legacyData)) {
                        trackedSellers = legacyData.map(item => ({
                            username: item.username,
                            addedAt: item.addedAt || Date.now(),
                            lastUpdated: item.lastUpdated || null,
                            releases: item.releases || [],
                            // Normalize legacy inventory if present
                            inventory: Array.isArray(item.inventory)
                                ? item.inventory.map(normalizeListingForInventory)
                                : [],
                            currentJob: null
                        }));

                        metadata = trackedSellers.map(({ username, addedAt, lastUpdated }) => ({
                            username,
                            addedAt,
                            lastUpdated
                        }));

                        await Promise.all(trackedSellers.map(seller => saveSellerDataToDB(seller)));
                        localStorage.removeItem('tracked_sellers');
                        localStorage.setItem(SELLER_METADATA_KEY, JSON.stringify(metadata));
                    }
                } catch (error) {
                    console.error('Failed to migrate legacy seller data:', error);
                }
            }
        }

        if (!metadata || !Array.isArray(metadata)) {
            metadata = [];
        }

        const sellersWithData = await Promise.all(metadata.map(async meta => {
            const stored = await getSellerDataFromDB(meta.username);
            return {
                username: meta.username,
                addedAt: meta.addedAt || Date.now(),
                lastUpdated: meta.lastUpdated || null,
                releases: stored?.releases || [],
                inventory: stored?.inventory || [],
                currentJob: null
            };
        }));

        trackedSellers = sellersWithData;
    } catch (error) {
        console.error('Failed to load tracked sellers:', error);
        trackedSellers = [];
    }

    updateSellerList();
    loadAllSellersData();
}

function saveTrackedSellers() {
    const metadata = trackedSellers.map(({ username, addedAt, lastUpdated }) => ({
        username,
        addedAt,
        lastUpdated
    }));

    try {
        localStorage.setItem(SELLER_METADATA_KEY, JSON.stringify(metadata));
        localStorage.removeItem('tracked_sellers');
    } catch (error) {
        console.error('Failed to persist seller metadata:', error);
    }
}

function updateSellerList() {
    const sellerList = document.getElementById('sellerList');
    const sellerCount = document.getElementById('sellerCount');
    const chips = document.getElementById('selectedChips');
    
    sellerCount.textContent = trackedSellers.length;
    chips.innerHTML = '';
    
    const chipsToShow = selectedSellers.length > 0 ? selectedSellers : trackedSellers.map(s => s.username);
    chipsToShow.forEach(name => {
        const span = document.createElement('span');
        span.className = 'selected-chip';
        span.textContent = name;
        chips.appendChild(span);
    });
    
    if (trackedSellers.length === 0) {
        sellerList.innerHTML = '<li class="text-muted text-center py-3">No sellers tracked yet. Add one above!</li>';
        return;
    }
    
    sellerList.innerHTML = '';
    trackedSellers.forEach(seller => {
        const li = document.createElement('li');
        li.className = 'seller-item';
        if (selectedSellers.length === 0 || selectedSellers.includes(seller.username)) {
            li.classList.add('active');
        }
        
        const releaseCount = seller.releases ? seller.releases.length : 0;
        const lastUpdated = seller.lastUpdated ? new Date(seller.lastUpdated).toLocaleDateString() : 'Never';
        const job = seller.currentJob;
        
        let jobMarkup = '';
        let cancelBtn = '';
        
        if (job && job.status === 'processing') {
            li.classList.add('processing');
            const percent = job.total > 0 ? Math.round((job.progress / job.total) * 100) : 0;
            const clampedPercent = Math.min(100, Math.max(0, percent));
            const safeStep = escapeHtml(job.currentStep || 'Processing...');
            const countLabel = job.total > 0 ? `${job.progress}/${job.total}` : '';
            const percentLabel = job.total > 0 ? `${percent}%` : '';
            const trailingLabel = percentLabel && countLabel ? `${percentLabel} â€¢ ${countLabel}` : (percentLabel || countLabel);
            
            jobMarkup = `
                <div class="seller-progress">
                    <div class="seller-progress-bar">
                        <div class="seller-progress-bar-fill" style="width: ${clampedPercent}%"></div>
                    </div>
                    <div class="seller-progress-text">
                        <span>${safeStep}</span>
                        <span>${trailingLabel || ''}</span>
                    </div>
                </div>
            `;
            
            if (job.jobId) {
                cancelBtn = `<button class="btn btn-sm btn-outline-warning" onclick="cancelJob('${job.jobId}', event)" title="Cancel">
                    <i class="bi bi-x-circle"></i>
                </button>`;
            }
        }
        
        li.innerHTML = `
            <div class="seller-info" onclick="toggleSeller('${seller.username}')">
                <div class="seller-name">${seller.username}</div>
                <div class="seller-meta">${releaseCount} releases â€¢ Updated: ${lastUpdated}</div>
                ${jobMarkup}
            </div>
            <div class="seller-actions">
                <button class="btn btn-sm btn-outline-primary" onclick="refreshSeller('${seller.username}', event)" title="Refresh">
                    <i class="bi bi-arrow-clockwise"></i>
                </button>
                <button class="btn btn-sm btn-outline-secondary" onclick="openSellerOptions('${seller.username}', event)" title="Options">
                    <i class="bi bi-sliders"></i>
                </button>
                ${cancelBtn}
                <button class="btn btn-sm btn-outline-danger" onclick="removeSeller('${seller.username}', event)" title="Remove">
                    <i class="bi bi-trash"></i>
                </button>
            </div>
        `;
        sellerList.appendChild(li);
    });
}

function toggleSeller(username) {
    const index = selectedSellers.indexOf(username);
    if (index === -1) {
        // If nothing selected, select this one
        if (selectedSellers.length === 0) {
            selectedSellers = [username];
        } else {
            selectedSellers.push(username);
        }
    } else {
        selectedSellers.splice(index, 1);
    }
    
    updateSellerList();
    
    // Only reload seller data if we're in the sellers view
    if (currentView === 'sellers') {
        loadAllSellersData();
    }
}

function openAddSellerModal() {
    const modal = new bootstrap.Modal(document.getElementById('addSellerModal'));
    document.getElementById('addSellerInput').value = '';
    modal.show();
}

function toggleSellersPanel() {
    const panel = document.getElementById('sellersPanel');
    const btn = document.getElementById('toggleSellersBtn');
    panel.classList.toggle('collapsed');
    if (panel.classList.contains('collapsed')) {
        btn.innerHTML = '<i class="bi bi-chevron-down"></i>';
    } else {
        btn.innerHTML = '<i class="bi bi-chevron-up"></i>';
    }
}

async function addSellerFromModal() {
    const sellerInput = document.getElementById('addSellerInput');
    const username = sellerInput.value.trim();
    
    if (!username) {
        alert('Please enter a seller username');
        return;
    }
    
    const modal = bootstrap.Modal.getInstance(document.getElementById('addSellerModal'));
    if (modal) {
        modal.hide();
    }
    
    await addSeller(username);
}

async function addSeller(username) {
    
    if (!username) {
        alert('Please enter a seller username');
        return;
    }
    
    const consumerKey = localStorage.getItem('discogs_consumer_key');
    const consumerSecret = localStorage.getItem('discogs_consumer_secret');
    
    if (!consumerKey || !consumerSecret) {
        alert('Please configure your Discogs API credentials in Settings');
        openSettings();
        return;
    }
    
    // Check if already tracked
    if (trackedSellers.find(s => s.username === username)) {
        alert('This seller is already being tracked');
        return;
    }
    
    // Add seller
    const newSeller = {
        username,
        addedAt: Date.now(),
        lastUpdated: null,
        releases: [],
        inventory: [],
        currentJob: null
    };
    
    trackedSellers.push(newSeller);
    saveTrackedSellers();
    await saveSellerDataToDB(newSeller);
    updateSellerList();
    
    // Track seller scan
    if (typeof gtag !== 'undefined') {
        gtag('event', 'seller_scan', {
            event_category: 'Seller Tracking',
            event_label: username
        });
    }
    
    // Start fetching and processing automatically
    await fetchAndProcessSeller(username);
}

async function removeSeller(username, event) {
    event.stopPropagation();
    
    if (!confirm(`Remove ${username} from tracked sellers?`)) return;
    
    trackedSellers = trackedSellers.filter(s => s.username !== username);
    selectedSellers = selectedSellers.filter(u => u !== username);
    
    await deleteSellerDataFromDB(username);
    saveTrackedSellers();
    updateSellerList();
    
    // Only reload seller data if we're in the sellers view
    if (currentView === 'sellers') {
        loadAllSellersData();
    }
}

async function refreshSeller(username, event) {
    event.stopPropagation();
    
    const seller = trackedSellers.find(s => s.username === username);
    if (!seller) return;
    
    // Track seller refresh
    if (typeof gtag !== 'undefined') {
        gtag('event', 'seller_scan', {
            event_category: 'Seller Tracking',
            event_label: `Refresh: ${username}`
        });
    }
    
    // Smart update: fetch inventory, compare, remove old releases, process only new ones
    await updateSellerWithDiff(username);
}

async function updateAllSellers() {
    if (!trackedSellers || trackedSellers.length === 0) {
        alert('No sellers to update. Add a seller first.');
        return;
    }
    if (!confirm('Update all sellers now? This will fetch latest inventories and update added/sold releases.')) {
        return;
    }
    
    // Track bulk update
    if (typeof gtag !== 'undefined') {
        gtag('event', 'seller_scan', {
            event_category: 'Seller Tracking',
            event_label: `Update All (${trackedSellers.length} sellers)`
        });
    }
    
    // Process sequentially to respect Discogs rate limits
    for (const seller of trackedSellers) {
        try {
            await updateSellerWithDiff(seller.username);
        } catch (e) {
            console.error('Failed to update seller', seller.username, e);
        }
    }
}

// Fetch inventory and automatically process all releases (for new sellers)
async function fetchAndProcessSeller(username) {
    const seller = trackedSellers.find(s => s.username === username);
    if (!seller) return;
    
    const jobId = 'job_' + Date.now();
    currentJobId = jobId;
    
    try {
        localStorage.setItem('currentJobId', jobId);
        localStorage.setItem('currentUsername', username);
    } catch (e) {
        console.warn('Could not store job metadata in localStorage:', e);
    }
    
    const job = createJob(jobId, username);
    seller.currentJob = job;
    updateSellerList();
    
    try {
        // Step 1: Fetch inventory (stored in compact normalized form)
        let allListings = [];
        updateJob(jobId, { currentStep: 'Fetching inventory...' });
        updateProgress(jobId);
        
        let page = 1;
        const perPage = 100;
        const maxPages = 100; // Discogs pagination limit
        
        while (page <= maxPages) {
            try {
                const inventory = await getSellerInventory(username, page, perPage);
                const listings = inventory.listings || [];
                
                if (listings.length === 0) break;

                // Store only compact normalized listings to reduce DB size
                allListings.push(...listings.map(normalizeListingForInventory));
                
                const totalPages = Math.min(inventory.pagination?.pages || 1, maxPages);
                updateJob(jobId, {
                    currentStep: `Fetching inventory: Page ${page} of ${totalPages}`,
                    progress: page,
                    total: totalPages
                });
                updateProgress(jobId);
                
                if (page >= totalPages) break;
                page++;
            } catch (error) {
                console.error(`Error fetching inventory page ${page}:`, error);
                
                // If we've already got some data, continue with what we have
                if (allListings.length > 0) {
                    console.log(`Continuing with ${allListings.length} items fetched so far`);
                    break;
                }
                
                // Otherwise, this is a fatal error
                throw error;
            }
        }
        
        if (allListings.length === 0) {
            updateJob(jobId, {
                status: 'error',
                currentStep: 'No listings found for this seller'
            });
            updateProgress(jobId);
            finishJob(jobId, username);
            return;
        }
        
        // Save inventory (already compact normalized listings)
        seller.inventory = allListings;
        await saveSellerDataToDB(seller);
        
        // Step 2: Automatically process all releases
        updateJob(jobId, { currentStep: 'Processing releases...' });
        updateProgress(jobId);
        
        await processAllReleasesFromInventory(jobId, username, allListings);
        
    } catch (error) {
        console.error('Error in fetchAndProcessSeller:', error);
        updateJob(jobId, {
            status: 'error',
            currentStep: `Error: ${error.message}`
        });
        updateProgress(jobId);
        finishJob(jobId, username);
    }
}

// Update seller with smart diff: fetch inventory, compare, remove old, process only new
async function updateSellerWithDiff(username) {
    const seller = trackedSellers.find(s => s.username === username);
    if (!seller) return;
    
    const jobId = 'job_' + Date.now();
    currentJobId = jobId;
    
    try {
        localStorage.setItem('currentJobId', jobId);
        localStorage.setItem('currentUsername', username);
    } catch (e) {
        console.warn('Could not store job metadata in localStorage:', e);
    }
    
    const job = createJob(jobId, username);
    seller.currentJob = job;
    updateSellerList();
    
    try {
        // Step 1: Fetch current inventory (stored in compact normalized form)
        let allListings = [];
        updateJob(jobId, { currentStep: 'Fetching inventory...' });
        updateProgress(jobId);
        
        let page = 1;
        const perPage = 100;
        const maxPages = 100; // Discogs pagination limit
        
        while (page <= maxPages) {
            try {
                const inventory = await getSellerInventory(username, page, perPage);
                const listings = inventory.listings || [];
                
                if (listings.length === 0) break;

                // Store only compact normalized listings to reduce DB size
                allListings.push(...listings.map(normalizeListingForInventory));
                
                const totalPages = Math.min(inventory.pagination?.pages || 1, maxPages);
                updateJob(jobId, {
                    currentStep: `Fetching inventory: Page ${page} of ${totalPages}`,
                    progress: page,
                    total: totalPages
                });
                updateProgress(jobId);
                
                if (page >= totalPages) break;
                page++;
            } catch (error) {
                console.error(`Error fetching inventory page ${page}:`, error);
                
                // If we've already got some data, continue with what we have
                if (allListings.length > 0) {
                    console.log(`Continuing with ${allListings.length} items fetched so far`);
                    break;
                }
                
                // Otherwise, this is a fatal error
                throw error;
            }
        }
        
        if (allListings.length === 0) {
            updateJob(jobId, {
                status: 'error',
                currentStep: 'No listings found for this seller'
            });
            updateProgress(jobId);
            finishJob(jobId, username);
            return;
        }
        
        // Step 2: Compare with existing releases
        updateJob(jobId, { currentStep: 'Comparing inventory...' });
        updateProgress(jobId);
        
        const uniqueReleases = {};
        for (const listing of allListings) {
            const info = getListingInfoFromInventory(listing);
            if (!info || !info.releaseId) continue;

            const price = info.price || 0;
            const cond = info.condition || '';
            const releaseId = info.releaseId;

            if (!uniqueReleases[releaseId] || (price > 0 && price < uniqueReleases[releaseId].price)) {
                uniqueReleases[releaseId] = {
                    id: releaseId,
                    artist: info.artist || 'Unknown Artist',
                    title: info.title || 'Unknown Title',
                    price: price,
                    condition: cond
                };
            }
        }
        
        const currentReleaseIds = Object.keys(uniqueReleases).map(id => parseInt(id));
        const existingReleases = seller.releases || [];
        const existingIds = new Set(existingReleases.map(r => r.id));
        
        // Find releases to remove (no longer in inventory)
        const removedIds = existingReleases.filter(r => !currentReleaseIds.includes(r.id)).map(r => r.id);
        
        // Find new releases to process
        const newReleaseIds = currentReleaseIds.filter(id => !existingIds.has(id));
        
        // Step 3: Remove releases no longer in inventory
        if (removedIds.length > 0) {
            seller.releases = existingReleases.filter(r => !removedIds.includes(r.id));
            console.log(`Removed ${removedIds.length} releases no longer in inventory`);
            await saveSellerDataToDB(seller);
            if (currentView === 'sellers') {
                loadAllSellersData();
            }
        }
        
        // Update inventory (already compact normalized listings)
        seller.inventory = allListings;
        await saveSellerDataToDB(seller);
        
        // Step 4: Process only new releases
        if (newReleaseIds.length === 0) {
            updateJob(jobId, {
                status: 'complete',
                currentStep: `All up to date! (${removedIds.length} removed)`,
                progress: 1,
                total: 1
            });
            updateProgress(jobId);
            
            seller.lastUpdated = Date.now();
            saveTrackedSellers();
            finishJob(jobId, username);
            return;
        }
        
        updateJob(jobId, {
            currentStep: `Processing ${newReleaseIds.length} new releases...`,
            progress: 0,
            total: newReleaseIds.length
        });
        updateProgress(jobId);
        
        // Process new releases
        await processNewReleases(jobId, username, newReleaseIds, uniqueReleases);
        
    } catch (error) {
        console.error('Error in updateSellerWithDiff:', error);
        updateJob(jobId, {
            status: 'error',
            currentStep: `Error: ${error.message}`
        });
        updateProgress(jobId);
        finishJob(jobId, username);
    }
}

// Process all releases from inventory (for new sellers)
async function processAllReleasesFromInventory(jobId, username, allListings) {
    const seller = trackedSellers.find(s => s.username === username);
    if (!seller) return;
    
    // Extract unique releases from compact or legacy inventory listings
    const uniqueReleases = {};
    for (const listing of allListings) {
        const info = getListingInfoFromInventory(listing);
        if (!info || !info.releaseId) continue;

        const price = info.price || 0;
        const cond = info.condition || '';
        const releaseId = info.releaseId;

        if (!uniqueReleases[releaseId] || (price > 0 && price < uniqueReleases[releaseId].price)) {
            uniqueReleases[releaseId] = {
                id: releaseId,
                artist: info.artist || 'Unknown Artist',
                title: info.title || 'Unknown Title',
                price: price,
                condition: cond
            };
        }
    }
    
    const releaseIds = Object.keys(uniqueReleases);
    
    updateJob(jobId, {
        total: releaseIds.length,
        progress: 0,
        currentStep: `Processing ${releaseIds.length} releases...`
    });
    updateProgress(jobId);
    
    const processedReleases = [];
    let failedReleases = 0;
    
    for (let i = 0; i < releaseIds.length; i++) {
        const job = getJobFromStorage(jobId);
        if (job && job.status === 'cancelled') {
            console.log('Job cancelled');
            return;
        }
        
        const releaseId = releaseIds[i];
        const basicInfo = uniqueReleases[releaseId];
        
        try {
            const details = await getReleaseDetails(releaseId);
            
            // Check style filter
            if (!shouldKeepReleaseForSeller(username, details)) {
                updateJob(jobId, {
                    progress: i + 1,
                    currentStep: `Skipping (style filter): ${i + 1} of ${releaseIds.length}`
                });
                updateProgress(jobId);
                continue;
            }

            // Extract release data
            const ratingData = details.community?.rating || {};
            const avgRating = parseFloat(ratingData.average || 0);
            const numRatings = parseInt(ratingData.count || 0);
            const bayesianScore = bayesianRating(avgRating, numRatings);
            
            const haveCount = parseInt(details.community?.have || 0);
            const wantCount = parseInt(details.community?.want || 0);
            
            const releaseData = {
                id: parseInt(releaseId),
                artist_title: `${basicInfo.artist} - ${basicInfo.title}`,
                artist: details.artists?.[0]?.name || basicInfo.artist,
                title: details.title || basicInfo.title,
                label: details.labels?.[0]?.name || null,
                year: details.year || null,
                genres: JSON.stringify(details.genres || []),
                styles: JSON.stringify(details.styles || []),
                avg_rating: avgRating,
                num_ratings: numRatings,
                bayesian_score: bayesianScore,
                price: basicInfo.price,
                condition: basicInfo.condition || '',
                have_count: haveCount,
                want_count: wantCount,
                youtube_video_id: null,
                video_urls: JSON.stringify(details.videos || []),
                url: `https://www.discogs.com/release/${releaseId}`,
                demand_coeff: computeRarityCoeff(haveCount, wantCount)
            };
            
            processedReleases.push(releaseData);
            
            updateJob(jobId, {
                progress: i + 1,
                currentStep: `Processing: ${i + 1} of ${releaseIds.length} releases`
            });
            updateProgress(jobId);
            
            seller.releases = processedReleases;
            
            // Save every 10 releases or at the end
            if ((i + 1) % 10 === 0 || i === releaseIds.length - 1) {
                await saveSellerDataToDB(seller);
                if (currentView === 'sellers') {
                    loadAllSellersData();
                }
            }
            
        } catch (error) {
            console.error(`Error fetching details for release ${releaseId}:`, error);
            failedReleases++;
            
            // If too many failures, stop processing but save what we have
            if (failedReleases >= 10) {
                console.warn(`Too many failures (${failedReleases}), stopping processing`);
                seller.releases = processedReleases;
                await saveSellerDataToDB(seller);
                
                updateJob(jobId, { 
                    status: 'complete', 
                    currentStep: `Processed ${processedReleases.length}/${releaseIds.length} releases (stopped due to errors)` 
                });
                updateProgress(jobId);
                seller.lastUpdated = Date.now();
                saveTrackedSellers();
                finishJob(jobId, username);
                return;
            }
            
            // Skip this release and continue
            console.warn(`Skipping release ${releaseId}, will continue with next`);
        }
    }
    
    seller.lastUpdated = Date.now();
    saveTrackedSellers();
    await saveSellerDataToDB(seller);
    updateSellerList();
    
    updateJob(jobId, {
        status: 'complete',
        currentStep: `Complete! Processed ${processedReleases.length} releases.`,
        progress: releaseIds.length
    });
    updateProgress(jobId);
    
    if (currentView === 'sellers') {
        loadAllSellersData();
    }
    finishJob(jobId, username);
}

// Process only new releases (for updates)
async function processNewReleases(jobId, username, newReleaseIds, uniqueReleases) {
    const seller = trackedSellers.find(s => s.username === username);
    if (!seller) return;
    
    const existingReleases = seller.releases || [];
    const processedReleases = [...existingReleases];
    let failedReleases = 0;
    
    for (let i = 0; i < newReleaseIds.length; i++) {
        const job = getJobFromStorage(jobId);
        if (job && job.status === 'cancelled') {
            console.log('Job cancelled');
            return;
        }
        
        const releaseId = newReleaseIds[i];
        const basicInfo = uniqueReleases[releaseId];
        
        try {
            const details = await getReleaseDetails(releaseId);
            
            // Check style filter
            if (!shouldKeepReleaseForSeller(username, details)) {
                updateJob(jobId, {
                    progress: i + 1,
                    currentStep: `Skipping (style filter): ${i + 1} of ${newReleaseIds.length}`
                });
                updateProgress(jobId);
                continue;
            }

            // Extract release data
            const ratingData = details.community?.rating || {};
            const avgRating = parseFloat(ratingData.average || 0);
            const numRatings = parseInt(ratingData.count || 0);
            const bayesianScore = bayesianRating(avgRating, numRatings);
            
            const haveCount = parseInt(details.community?.have || 0);
            const wantCount = parseInt(details.community?.want || 0);
            
            const releaseData = {
                id: parseInt(releaseId),
                artist_title: `${basicInfo.artist} - ${basicInfo.title}`,
                artist: details.artists?.[0]?.name || basicInfo.artist,
                title: details.title || basicInfo.title,
                label: details.labels?.[0]?.name || null,
                year: details.year || null,
                genres: JSON.stringify(details.genres || []),
                styles: JSON.stringify(details.styles || []),
                avg_rating: avgRating,
                num_ratings: numRatings,
                bayesian_score: bayesianScore,
                price: basicInfo.price,
                condition: basicInfo.condition || '',
                have_count: haveCount,
                want_count: wantCount,
                youtube_video_id: null,
                video_urls: JSON.stringify(details.videos || []),
                url: `https://www.discogs.com/release/${releaseId}`,
                demand_coeff: computeRarityCoeff(haveCount, wantCount)
            };
            
            processedReleases.push(releaseData);
            
            updateJob(jobId, {
                progress: i + 1,
                currentStep: `Processing: ${i + 1} of ${newReleaseIds.length} new releases`
            });
            updateProgress(jobId);
            
            seller.releases = processedReleases;
            
            // Save every 10 releases or at the end
            if ((i + 1) % 10 === 0 || i === newReleaseIds.length - 1) {
                await saveSellerDataToDB(seller);
                if (currentView === 'sellers') {
                    loadAllSellersData();
                }
            }
            
        } catch (error) {
            console.error(`Error fetching details for release ${releaseId}:`, error);
            failedReleases++;
            
            // If too many failures, stop processing but save what we have
            if (failedReleases >= 10) {
                console.warn(`Too many failures (${failedReleases}), stopping processing`);
                seller.releases = processedReleases;
                await saveSellerDataToDB(seller);
                
                updateJob(jobId, { 
                    status: 'complete', 
                    currentStep: `Processed ${processedReleases.length - existingReleases.length} new releases (stopped due to errors)` 
                });
                updateProgress(jobId);
                seller.lastUpdated = Date.now();
                saveTrackedSellers();
                finishJob(jobId, username);
                return;
            }
            
            // Skip this release and continue
            console.warn(`Skipping release ${releaseId}, will continue with next`);
        }
    }
    
    seller.lastUpdated = Date.now();
    saveTrackedSellers();
    await saveSellerDataToDB(seller);
    updateSellerList();
    
    updateJob(jobId, {
        status: 'complete',
        currentStep: `Complete! Processed ${newReleaseIds.length} new releases.`,
        progress: newReleaseIds.length
    });
    updateProgress(jobId);
    
    if (currentView === 'sellers') {
        loadAllSellersData();
    }
    finishJob(jobId, username);
}

async function loadAllSellersData() {
    currentView = 'sellers';
    updateBrandActiveState();
    
    // Show sellers panel
    const sellersPanel = document.getElementById('sellersPanel');
    if (sellersPanel) sellersPanel.style.display = 'block';
    
    // Fetch wantlist IDs if logged in
    if (oauthUser && userAccessToken) {
        await fetchUserWantlistIds();
    }
    
    allData = [];
    
    const sellersToShow = selectedSellers.length > 0 ? selectedSellers : trackedSellers.map(s => s.username);
    
    sellersToShow.forEach(username => {
        const seller = trackedSellers.find(s => s.username === username);
        if (seller && seller.releases) {
            // Apply per-seller style preferences
            const filteredReleases = filterReleasesBySellerStyles(seller, seller.releases);

            // Add seller info to each release and mark if in wantlist
            const releasesWithSeller = filteredReleases.map(r => ({
                ...r,
                seller_username: username,
                inWantlist: userWantlistIds.has(r.id)
            }));
            allData.push(...releasesWithSeller);
        }
    });
    
    if (allData.length > 0) {
        hasSearched = true;
        const processingActive = isProcessingActive();
        displayResults(allData, processingActive);
    } else {
        const tbody = document.getElementById('releases-table-body');
        tbody.innerHTML = '<tr><td class="no-results" colspan="15"><p>No releases yet. Add sellers and they will appear here.</p></td></tr>';
    }
}

// ==================== HELPER FUNCTIONS ====================
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function bayesianRating(avgRating, numRatings, minNumRatings = 10) {
    if (numRatings === 0) return 0.0;
    const priorMean = 2.5;
    return (avgRating * numRatings + priorMean * minNumRatings) / (numRatings + minNumRatings);
}

function computeRarityCoeff(have, want) {
    const h = typeof have === 'number' ? have : parseFloat(have) || 0;
    const w = typeof want === 'number' ? want : parseFloat(want) || 0;
    return (w + 1) / (h + 1);
}

// Determine whether a release should be kept for a given seller based on style preferences
function releaseMatchesSellerStyles(sellerUsername, release) {
    const selected = getSellerSelectedStyles(sellerUsername);
    if (selected === null) {
        return true; // default: all styles allowed
    }
    if (selected.length === 0) return false; // user cleared everything

    if (!release || !release.styles) return false;

    let styles = [];
    try {
        styles = JSON.parse(release.styles) || [];
    } catch (e) {
        styles = [];
    }
    if (!Array.isArray(styles) || styles.length === 0) return false;

    return styles.some((style) => selected.includes(style));
}

// Filter a list of releases for a seller using style preferences
function filterReleasesBySellerStyles(seller, releases) {
    if (!Array.isArray(releases) || releases.length === 0) return [];
    const username = seller?.username;
    if (!username) return releases;
    const selected = getSellerSelectedStyles(username);
    if (selected === null) return releases;
    return releases.filter((release) => releaseMatchesSellerStyles(username, release));
}

function shouldKeepReleaseForSeller(username, releaseDetails) {
    const selected = getSellerSelectedStyles(username);
    if (selected === null) {
        return true;
    }
    if (selected.length === 0) {
        return false;
    }
    if (!releaseDetails) {
        return false;
    }

    let styles = [];
    if (Array.isArray(releaseDetails.styles) && releaseDetails.styles.length > 0) {
        styles = releaseDetails.styles;
    } else if (
        releaseDetails.basic_information &&
        Array.isArray(releaseDetails.basic_information.styles)
    ) {
        styles = releaseDetails.basic_information.styles;
    }

    if (!styles || styles.length === 0) {
        return false;
    }

    return styles.some((style) => selected.includes(style));
}

function getVideoUrl(video) {
    if (!video || typeof video !== 'object') return '';
    return video.url || video.uri || video.href || '';
}

function sanitizeVideoLinks(videoLinks) {
    if (!Array.isArray(videoLinks)) return [];
    const sanitized = [];
    videoLinks.forEach(video => {
        const url = getVideoUrl(video);
        if (!url) return;
        sanitized.push({
            url,
            title: video?.title || ''
        });
    });
    return sanitized;
}

function extractYouTubeID(url) {
    if (!url) return null;
    const regex = /(?:youtube\.com\/.*v=|youtu\.be\/)([^"&?/\s]{11})/;
    const match = url.match(regex);
    return match ? match[1] : null;
}

// ==================== SELLER OPTIONS (STYLES) ====================

function getSellerStylesFrequency(seller) {
    const freqMap = new Map();
    if (!seller || !Array.isArray(seller.releases)) return [];

    seller.releases.forEach(release => {
        if (!release || !release.styles) return;
        let styles = [];
        try {
            styles = JSON.parse(release.styles) || [];
        } catch (e) {
            styles = [];
        }
        if (!Array.isArray(styles)) return;
        styles.forEach(style => {
            if (!style) return;
            const current = freqMap.get(style) || 0;
            freqMap.set(style, current + 1);
        });
    });

    const entries = Array.from(freqMap.entries());
    // Sort by frequency (desc), then alphabetically
    entries.sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
    });
    return entries;
}

function openSellerOptions(username, event) {
    if (event && typeof event.stopPropagation === 'function') {
        event.stopPropagation();
    }
    const seller = trackedSellers.find(s => s.username === username);
    const titleEl = document.getElementById('sellerOptionsTitle');
    const nameEl = document.getElementById('sellerOptionsName');
    const sectionEl = document.getElementById('sellerStylesSection');
    const emptyEl = document.getElementById('sellerStylesEmpty');
    const containerEl = document.getElementById('sellerStylesContainer');

    if (!seller || !titleEl || !nameEl || !sectionEl || !emptyEl || !containerEl) {
        return;
    }

    titleEl.textContent = `Seller Options â€“ ${username}`;
    nameEl.textContent = username;

    // Build styles list
    const entries = getSellerStylesFrequency(seller);
    containerEl.innerHTML = '';

    if (!entries.length) {
        sectionEl.style.display = 'none';
        emptyEl.style.display = 'block';
    } else {
        sectionEl.style.display = 'block';
        emptyEl.style.display = 'none';

        const prefs = sellerStylePreferences[username];
        const selected = prefs && Array.isArray(prefs.selectedStyles)
            ? new Set(prefs.selectedStyles)
            : null; // null => default (all selected)

        entries.forEach(([style, count], index) => {
            const id = `seller-style-${index}`;
            const wrapper = document.createElement('div');
            wrapper.className = 'form-check form-check-sm';

            const input = document.createElement('input');
            input.className = 'form-check-input seller-style-checkbox';
            input.type = 'checkbox';
            input.id = id;
            input.value = style;

            // Default: all selected
            if (selected === null) {
                input.checked = true;
            } else {
                input.checked = selected.has(style);
            }

            const label = document.createElement('label');
            label.className = 'form-check-label';
            label.htmlFor = id;
            label.textContent = `${style} (${count})`;

            wrapper.appendChild(input);
            wrapper.appendChild(label);
            containerEl.appendChild(wrapper);
        });
    }

    // Store current seller username on modal element for save helper
    const modalEl = document.getElementById('sellerOptionsModal');
    if (modalEl) {
        modalEl.setAttribute('data-seller-username', username);
        const modal = new bootstrap.Modal(modalEl);
        modal.show();
    }
}

function selectAllSellerStyles(checked) {
    const containerEl = document.getElementById('sellerStylesContainer');
    if (!containerEl) return;
    const inputs = containerEl.querySelectorAll('.seller-style-checkbox');
    inputs.forEach(input => {
        input.checked = !!checked;
    });
}

function saveSellerOptions() {
    const modalEl = document.getElementById('sellerOptionsModal');
    if (!modalEl) return;
    const username = modalEl.getAttribute('data-seller-username');
    if (!username) return;

    const containerEl = document.getElementById('sellerStylesContainer');
    if (!containerEl) return;

    const inputs = Array.from(containerEl.querySelectorAll('.seller-style-checkbox'));
    const selectedStyles = inputs.filter(input => input.checked).map(input => input.value);

    if (!sellerStylePreferences || typeof sellerStylePreferences !== 'object') {
        sellerStylePreferences = {};
    }

    // If all styles are selected, we can remove explicit prefs and fall back to default
    const totalStyles = inputs.length;
    if (selectedStyles.length === 0) {
        sellerStylePreferences[username] = { selectedStyles: [] };
    } else if (selectedStyles.length === totalStyles) {
        delete sellerStylePreferences[username];
    } else {
        sellerStylePreferences[username] = { selectedStyles };
    }

    try {
        localStorage.setItem(SELLER_STYLE_PREFS_KEY, JSON.stringify(sellerStylePreferences));
    } catch (e) {
        console.warn('Failed to persist seller style preferences:', e);
    }

    // Immediately re-apply filters if we are in the sellers view
    if (currentView === 'sellers') {
        loadAllSellersData();
    }

    const modal = bootstrap.Modal.getInstance(modalEl);
    if (modal) {
        modal.hide();
    }
}

// ==================== USER AUTHENTICATION ====================

// Load user auth state from localStorage on init
function loadOAuthState() {
    const token = localStorage.getItem('discogs_user_token');
    const userStr = localStorage.getItem('oauth_user');
    
    if (token && userStr) {
        userAccessToken = token;
        try {
            oauthUser = JSON.parse(userStr);
            updateOAuthUI();
            // Load cached collection and wantlist data
            loadCollectionCache();
            loadWantlistCache();
            // Fetch wantlist IDs in background
            fetchUserWantlistIds();
        } catch (e) {
            console.error('Failed to parse user data:', e);
        }
    } else if (token) {
        // Have token but no user data, fetch it
        userAccessToken = token;
        fetchUserIdentity();
    }
}

// Update UI based on auth state
function updateOAuthUI() {
    const collectionIcon = document.getElementById('collectionIcon');
    const wantlistIcon = document.getElementById('wantlistIcon');
    const tokenLoginSection = document.getElementById('tokenLoginSection');
    const tokenLoggedInSection = document.getElementById('tokenLoggedInSection');
    const profileUsername = document.getElementById('profileUsername');
    
    if (oauthUser) {
        // Show collection and wantlist icons
        if (collectionIcon) collectionIcon.style.display = 'inline-block';
        if (wantlistIcon) wantlistIcon.style.display = 'inline-block';
        updateBrandActiveState();
        
        // Update profile modal
        if (tokenLoginSection) tokenLoginSection.style.display = 'none';
        if (tokenLoggedInSection) tokenLoggedInSection.style.display = 'block';
        if (profileUsername) profileUsername.textContent = oauthUser.username;
    } else {
        // Hide collection and wantlist icons
        if (collectionIcon) collectionIcon.style.display = 'none';
        if (wantlistIcon) wantlistIcon.style.display = 'none';
        updateBrandActiveState();
        
        // Update profile modal
        if (tokenLoginSection) tokenLoginSection.style.display = 'block';
        if (tokenLoggedInSection) tokenLoggedInSection.style.display = 'none';
    }
}

// Reflect currentView in brand icons
function updateBrandActiveState() {
    const collectionIcon = document.getElementById('collectionIcon');
    const wantlistIcon = document.getElementById('wantlistIcon');
    if (collectionIcon) collectionIcon.classList.remove('active');
    if (wantlistIcon) wantlistIcon.classList.remove('active');
    if (currentView === 'collection' && collectionIcon) {
        collectionIcon.classList.add('active');
    } else if (currentView === 'wantlist' && wantlistIcon) {
        wantlistIcon.classList.add('active');
    }
}

// Toggle user dropdown menu
function toggleUserDropdown() {
    const menu = document.getElementById('userDropdownMenu');
    menu.classList.toggle('show');
}

// Close dropdown when clicking outside
document.addEventListener('click', function(e) {
    const userSection = document.getElementById('oauthUserSection');
    const menu = document.getElementById('userDropdownMenu');
    if (userSection && menu && !userSection.contains(e.target)) {
        menu.classList.remove('show');
    }
});

// Show OAuth login instructions
function showOAuthInstructions() {
    const modal = new bootstrap.Modal(document.getElementById('oauthLoginModal'));
    document.getElementById('userTokenInput').value = '';
    modal.show();
}

// Login with personal access token
async function loginWithToken() {
    const tokenInput = document.getElementById('userTokenInput');
    const token = tokenInput.value.trim();
    
    if (!token) {
        alert('Please enter your personal access token.');
        return;
    }
    
    // Store token
    userAccessToken = token;
    localStorage.setItem('discogs_user_token', token);
    
    // Close modal
    const modal = bootstrap.Modal.getInstance(document.getElementById('oauthLoginModal'));
    if (modal) {
        modal.hide();
    }
    
    // Fetch user identity
    try {
        await fetchUserIdentity();
        alert('Successfully logged in to Discogs!');
    } catch (error) {
        console.error('Login error:', error);
        alert('Failed to login. Please check your token and try again.');
        userAccessToken = null;
        localStorage.removeItem('discogs_user_token');
    }
}

// Login with token from profile modal
async function loginWithTokenFromProfile() {
    const tokenInput = document.getElementById('profileTokenInput');
    const token = tokenInput.value.trim();
    
    if (!token) {
        alert('Please enter your personal access token.');
        return;
    }
    
    // Store token
    userAccessToken = token;
    localStorage.setItem('discogs_user_token', token);
    
    // Fetch user identity
    try {
        await fetchUserIdentity();
        alert('Successfully logged in to Discogs!');
        
        // Close modal after successful login
        const modal = bootstrap.Modal.getInstance(document.getElementById('profileModal'));
        if (modal) {
            modal.hide();
        }
    } catch (error) {
        console.error('Login error:', error);
        alert('Failed to login. Please check your token and try again.');
        userAccessToken = null;
        localStorage.removeItem('discogs_user_token');
    }
}

// Fetch authenticated user identity
async function fetchUserIdentity() {
    if (!userAccessToken) {
        return;
    }
    
    try {
        const identityUrl = 'https://api.discogs.com/oauth/identity';
        
        const response = await fetch(identityUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Discogs token=${userAccessToken}`,
                'User-Agent': 'DiscogsTrackr/1.0'
            }
        });
        
        if (!response.ok) {
            throw new Error(`Failed to fetch identity: ${response.status}`);
        }
        
        const userData = await response.json();
        oauthUser = userData;
        localStorage.setItem('oauth_user', JSON.stringify(userData));
        
        updateOAuthUI();
        
        // Fetch wantlist IDs in background
        fetchUserWantlistIds();
        
    } catch (error) {
        console.error('Failed to fetch user identity:', error);
        throw error;
    }
}

// Logout
function logoutOAuth() {
    // Clear cache before clearing oauthUser (needed for username)
    clearUserCache();
    
    oauthUser = null;
    userAccessToken = null;
    userWantlistIds.clear();
    
    localStorage.removeItem('discogs_user_token');
    localStorage.removeItem('oauth_user');
    
    updateOAuthUI();
    alert('Successfully logged out.');
}

// Make authenticated API request with token
async function makeAuthenticatedRequest(url) {
    if (!userAccessToken) {
        throw new Error('Not authenticated. Please log in first.');
    }

	// Optional proxy to work around Discogs CORS (set `discogs_proxy_url` in localStorage)
	const proxyBase = localStorage.getItem('discogs_proxy_url') || '';
	const targetUrl = proxyBase ? `${proxyBase}?url=${encodeURIComponent(url)}` : url;

	const useProxy = Boolean(proxyBase);
	const headers = useProxy
		? {
			// Send auth to proxy, which forwards to Discogs
			'X-Forward-Authorization': `Discogs token=${userAccessToken}`,
			'X-Forward-User-Agent': 'DiscogsTrackr/1.0'
		}
		: {
			'Authorization': `Discogs token=${userAccessToken}`,
			'User-Agent': 'DiscogsTrackr/1.0'
		};

	const response = await fetch(targetUrl, {
        method: 'GET',
		headers
    });
    
    if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
    }
    
    return await response.json();
}

// Fetch user's wantlist IDs to check which releases are wanted
async function fetchUserWantlistIds() {
    if (!oauthUser || !userAccessToken) {
        return;
    }
    
    try {
        const username = oauthUser.username;
        // Fetch first page to get total
		const firstPageUrl = `https://api.discogs.com/users/${username}/wants?per_page=100&page=1`;
        const firstPage = await makeAuthenticatedRequest(firstPageUrl);
        
        userWantlistIds.clear();
        
        // Add IDs from first page
        if (firstPage.wants) {
            firstPage.wants.forEach(item => {
                userWantlistIds.add(item.basic_information.id);
            });
        }
        
        // Fetch remaining pages if needed
        const totalPages = firstPage.pagination?.pages || 1;
        if (totalPages > 1) {
            const pagePromises = [];
            for (let page = 2; page <= Math.min(totalPages, 10); page++) { // Limit to 10 pages (1000 items)
                const pageUrl = `https://api.discogs.com/users/${username}/wants?per_page=100&page=${page}`;
                pagePromises.push(makeAuthenticatedRequest(pageUrl));
            }
            
            const pages = await Promise.all(pagePromises);
            pages.forEach(pageData => {
                if (pageData.wants) {
                    pageData.wants.forEach(item => {
                        userWantlistIds.add(item.basic_information.id);
                    });
                }
            });
        }
        
        console.log(`Loaded ${userWantlistIds.size} items from wantlist`);
    } catch (error) {
        console.error('Failed to fetch wantlist IDs:', error);
    }
}

// Fetch ALL collection releases across pages (returns array of entries with basic_information)
async function fetchAllCollectionReleases(username) {
    const firstPageUrl = `https://api.discogs.com/users/${username}/collection/folders/0/releases?per_page=100&page=1`;
    const firstPage = await makeAuthenticatedRequest(firstPageUrl);
    const releases = [...(firstPage.releases || [])];
    const totalPages = firstPage.pagination?.pages || 1;
    if (totalPages > 1) {
        const pagePromises = [];
        for (let page = 2; page <= totalPages; page++) {
            const pageUrl = `https://api.discogs.com/users/${username}/collection/folders/0/releases?per_page=100&page=${page}`;
            pagePromises.push(makeAuthenticatedRequest(pageUrl));
        }
        const pages = await Promise.all(pagePromises);
        pages.forEach(p => {
            if (p.releases) releases.push(...p.releases);
        });
    }
    return releases;
}

// Show user collection
async function showUserCollection() {
    if (!oauthUser) {
        alert('Please log in first. Go to Profile to enter your access token.');
        return;
    }
    
    currentView = 'collection';
    updateBrandActiveState();
    
    // Hide sellers panel
    const sellersPanel = document.getElementById('sellersPanel');
    if (sellersPanel) sellersPanel.style.display = 'none';
    
    // Show loading in table
    const tbody = document.getElementById('releases-table-body');
    tbody.innerHTML = '<tr><td colspan="15" class="text-center py-5"><div class="spinner-border" role="status"><span class="visually-hidden">Loading...</span></div><p class="mt-2">Loading your collection...</p></td></tr>';
    
    try {
        const username = oauthUser.username;
        const releasesAll = await fetchAllCollectionReleases(username);
        
        if (!releasesAll || releasesAll.length === 0) {
            tbody.innerHTML = '<tr><td colspan="15" class="text-center py-5"><div class="alert alert-info">Your collection is empty.</div></td></tr>';
            return;
        }
        
        // Get current release IDs (ALL pages)
        const currentCollectionIds = new Set(releasesAll.map(item => item.basic_information.id));
        
        // Determine what changed
        const addedIds = [...currentCollectionIds].filter(id => !lastCollectionIds.has(id));
        const removedIds = [...lastCollectionIds].filter(id => !currentCollectionIds.has(id));
        
        // Check if we have cached data and only need to update
        if (cachedCollectionData && (addedIds.length > 0 || removedIds.length > 0)) {
            // Incremental update
            console.log(`Collection changed: +${addedIds.length} added, -${removedIds.length} removed`);
            
            // Remove deleted items from cache
            let updatedCollection = cachedCollectionData.filter(item => !removedIds.includes(item.id));
            
            if (addedIds.length > 0) {
                // Show enriching status for new items
                tbody.innerHTML = `<tr><td colspan="15" class="text-center py-5">
                    <div class="spinner-border" role="status"></div>
                    <p class="mt-2 mb-1">Enriching ${addedIds.length} new item(s)...</p>
                    <p class="mb-0" id="enrichProgress"><strong>0 / ${addedIds.length}</strong> (0%)</p>
                </td></tr>`;
                
                // Enrich only new items
                for (let i = 0; i < addedIds.length; i++) {
                    const releaseId = addedIds[i];
                    const item = releasesAll.find(r => r.basic_information.id === releaseId);
                    const release = item.basic_information;
                    
                    try {
                        // Fetch full release data
                        const fullRelease = await makeDiscogsRequest(`https://api.discogs.com/releases/${release.id}`);
                        
                        const enrichedRelease = {
                            id: release.id,
                            title: fullRelease.title || release.title,
                            artist: release.artists?.map(a => a.name).join(', ') || '',
                            artist_title: fullRelease.title || release.title,
                            label: release.labels?.map(l => l.name).join(', ') || '',
                            year: fullRelease.year || release.year || '',
                            genres: JSON.stringify(fullRelease.genres || release.genres || []),
                            styles: JSON.stringify(fullRelease.styles || release.styles || []),
                            url: `https://www.discogs.com/release/${release.id}`,
                            avg_rating: fullRelease.community?.rating?.average || 0,
                            num_ratings: fullRelease.community?.rating?.count || 0,
                            seller_username: 'My Collection',
                            demand_coeff: fullRelease.community ? (fullRelease.community.want + 1) / (fullRelease.community.have + 1) : 0,
                            have_count: fullRelease.community?.have || 0,
                            want_count: fullRelease.community?.want || 0,
                            price: 0,
                            video_urls: JSON.stringify(fullRelease.videos || []),
                            bayesian_score: fullRelease.community?.rating?.average || 0,
                            inWantlist: userWantlistIds.has(release.id)
                        };
                        
                        updatedCollection.push(enrichedRelease);
                    } catch (error) {
                        console.error(`Failed to fetch full data for release ${release.id}:`, error);
                    }
                    
                    // Update progress
                    const progressEl = document.getElementById('enrichProgress');
                    if (progressEl) {
                        const completed = i + 1;
                        const percentage = Math.round((completed / addedIds.length) * 100);
                        progressEl.innerHTML = `<strong>${completed} / ${addedIds.length}</strong> (${percentage}%)`;
                    }
                }
            }
            
            // Update cache and IDs
            cachedCollectionData = updatedCollection;
            lastCollectionIds = currentCollectionIds;
            saveCollectionCache();
            
            // Display updated data
            allData = updatedCollection;
            hasSearched = true;
            displayResults(updatedCollection, false);
            
        } else if (cachedCollectionData && addedIds.length === 0 && removedIds.length === 0) {
            // No changes, use cached data
            console.log('Collection unchanged, using cache');
            allData = cachedCollectionData;
            hasSearched = true;
            displayResults(cachedCollectionData, false);
            
        } else {
            // First time or cache invalidated - full enrichment
            console.log('Performing full collection enrichment');
            
            // Fetch full release data for each item to get ratings, have/want, videos
            const totalItems = releasesAll.length;
            tbody.innerHTML = `<tr><td colspan="15" class="text-center py-5">
                <div class="spinner-border" role="status"></div>
                <p class="mt-2 mb-1">Enriching collection data...</p>
                <p class="mb-0" id="enrichProgress"><strong>0 / ${totalItems}</strong> (0%)</p>
            </td></tr>`;
            
            const collectionReleases = [];
            for (let i = 0; i < releasesAll.length; i++) {
                const item = releasesAll[i];
                const release = item.basic_information;
            
            try {
                // Fetch full release data
                const fullRelease = await makeDiscogsRequest(`https://api.discogs.com/releases/${release.id}`);
                
                const enrichedRelease = {
                    id: release.id,
                    title: fullRelease.title || release.title,
                    artist: release.artists?.map(a => a.name).join(', ') || '',
                    artist_title: fullRelease.title || release.title,
                    label: release.labels?.map(l => l.name).join(', ') || '',
                    year: fullRelease.year || release.year || '',
                    genres: JSON.stringify(fullRelease.genres || release.genres || []),
                    styles: JSON.stringify(fullRelease.styles || release.styles || []),
                    url: `https://www.discogs.com/release/${release.id}`,
                    avg_rating: fullRelease.community?.rating?.average || 0,
                    num_ratings: fullRelease.community?.rating?.count || 0,
                    seller_username: 'My Collection',
                    demand_coeff: fullRelease.community ? (fullRelease.community.want + 1) / (fullRelease.community.have + 1) : 0,
                    have_count: fullRelease.community?.have || 0,
                    want_count: fullRelease.community?.want || 0,
                    price: 0,
                    video_urls: JSON.stringify(fullRelease.videos || []),
                    bayesian_score: fullRelease.community?.rating?.average || 0
                };
                
                collectionReleases.push(enrichedRelease);
            } catch (error) {
                console.error(`Failed to fetch full data for release ${release.id}:`, error);
                // Fallback to basic data
                collectionReleases.push({
                    id: release.id,
                    title: release.title,
                    artist: release.artists?.map(a => a.name).join(', ') || '',
                    artist_title: release.title,
                    label: release.labels?.map(l => l.name).join(', ') || '',
                    year: release.year || '',
                    genres: JSON.stringify(release.genres || []),
                    styles: JSON.stringify(release.styles || []),
                    url: `https://www.discogs.com/release/${release.id}`,
                    avg_rating: 0,
                    num_ratings: 0,
                    seller_username: 'My Collection',
                    demand_coeff: 0,
                    have_count: 0,
                    want_count: 0,
                    price: 0,
                    video_urls: JSON.stringify([]),
                    bayesian_score: 0
                });
            }
            
            // Update progress
            const progressEl = document.getElementById('enrichProgress');
            if (progressEl) {
                const completed = i + 1;
                const percentage = Math.round((completed / totalItems) * 100);
                progressEl.innerHTML = `<strong>${completed} / ${totalItems}</strong> (${percentage}%)`;
                }
            }
            
            // Cache the enriched data and save IDs
            cachedCollectionData = collectionReleases;
            lastCollectionIds = currentCollectionIds;
            saveCollectionCache();
            
            // Display in table
            allData = collectionReleases;
            hasSearched = true;
            displayResults(collectionReleases, false);
        }
        
    } catch (error) {
        console.error('Failed to fetch collection:', error);
        tbody.innerHTML = '<tr><td colspan="15" class="text-center py-5"><div class="alert alert-danger">Failed to load collection. Please try again.</div></td></tr>';
    }
}

// Show user wantlist
async function showUserWantlist() {
    if (!oauthUser) {
        alert('Please log in first. Go to Profile to enter your access token.');
        return;
    }
    
    currentView = 'wantlist';
    updateBrandActiveState();
    
    // Hide sellers panel
    const sellersPanel = document.getElementById('sellersPanel');
    if (sellersPanel) sellersPanel.style.display = 'none';
    
    // Show loading in table
    const tbody = document.getElementById('releases-table-body');
    tbody.innerHTML = '<tr><td colspan="15" class="text-center py-5"><div class="spinner-border" role="status"><span class="visually-hidden">Loading...</span></div><p class="mt-2">Loading your wantlist...</p></td></tr>';
    
    try {
        const username = oauthUser.username;
        const wantlistUrl = `https://api.discogs.com/users/${username}/wants?per_page=100`;
        
        const data = await makeAuthenticatedRequest(wantlistUrl);
        
        if (!data.wants || data.wants.length === 0) {
            tbody.innerHTML = '<tr><td colspan="15" class="text-center py-5"><div class="alert alert-info">Your wantlist is empty.</div></td></tr>';
            return;
        }
        
        // Get current release IDs
        const currentWantlistIds = new Set(data.wants.map(item => item.basic_information.id));
        
        // Determine what changed
        const addedIds = [...currentWantlistIds].filter(id => !lastWantlistIds.has(id));
        const removedIds = [...lastWantlistIds].filter(id => !currentWantlistIds.has(id));
        
        // Check if we have cached data and only need to update
        if (cachedWantlistData && (addedIds.length > 0 || removedIds.length > 0)) {
            // Incremental update
            console.log(`Wantlist changed: +${addedIds.length} added, -${removedIds.length} removed`);
            
            // Remove deleted items from cache
            let updatedWantlist = cachedWantlistData.filter(item => !removedIds.includes(item.id));
            
            if (addedIds.length > 0) {
                // Show enriching status for new items
                tbody.innerHTML = `<tr><td colspan="15" class="text-center py-5">
                    <div class="spinner-border" role="status"></div>
                    <p class="mt-2 mb-1">Enriching ${addedIds.length} new item(s)...</p>
                    <p class="mb-0" id="enrichProgress"><strong>0 / ${addedIds.length}</strong> (0%)</p>
                </td></tr>`;
                
                // Enrich only new items
                for (let i = 0; i < addedIds.length; i++) {
                    const releaseId = addedIds[i];
                    const item = data.wants.find(w => w.basic_information.id === releaseId);
                    const release = item.basic_information;
                    
                    try {
                        // Fetch full release data
                        const fullRelease = await makeDiscogsRequest(`https://api.discogs.com/releases/${release.id}`);
                        
                        const enrichedRelease = {
                            id: release.id,
                            title: fullRelease.title || release.title,
                            artist: release.artists?.map(a => a.name).join(', ') || '',
                            artist_title: fullRelease.title || release.title,
                            label: release.labels?.map(l => l.name).join(', ') || '',
                            year: fullRelease.year || release.year || '',
                            genres: JSON.stringify(fullRelease.genres || release.genres || []),
                            styles: JSON.stringify(fullRelease.styles || release.styles || []),
                            url: `https://www.discogs.com/release/${release.id}`,
                            avg_rating: fullRelease.community?.rating?.average || 0,
                            num_ratings: fullRelease.community?.rating?.count || 0,
                            seller_username: 'My Wantlist',
                            demand_coeff: fullRelease.community ? (fullRelease.community.want + 1) / (fullRelease.community.have + 1) : 0,
                            have_count: fullRelease.community?.have || 0,
                            want_count: fullRelease.community?.want || 0,
                            price: 0,
                            video_urls: JSON.stringify(fullRelease.videos || []),
                            bayesian_score: fullRelease.community?.rating?.average || 0,
                            notes: item.notes || '',
                            inWantlist: true
                        };
                        
                        updatedWantlist.push(enrichedRelease);
                    } catch (error) {
                        console.error(`Failed to fetch full data for release ${release.id}:`, error);
                    }
                    
                    // Update progress
                    const progressEl = document.getElementById('enrichProgress');
                    if (progressEl) {
                        const completed = i + 1;
                        const percentage = Math.round((completed / addedIds.length) * 100);
                        progressEl.innerHTML = `<strong>${completed} / ${addedIds.length}</strong> (${percentage}%)`;
                    }
                }
            }
            
            // Update cache and IDs
            cachedWantlistData = updatedWantlist;
            lastWantlistIds = currentWantlistIds;
            saveWantlistCache();
            
            // Display updated data
            allData = updatedWantlist;
            hasSearched = true;
            displayResults(updatedWantlist, false);
            
        } else if (cachedWantlistData && addedIds.length === 0 && removedIds.length === 0) {
            // No changes, use cached data
            console.log('Wantlist unchanged, using cache');
            allData = cachedWantlistData;
            hasSearched = true;
            displayResults(cachedWantlistData, false);
            
        } else {
            // First time or cache invalidated - full enrichment
            console.log('Performing full wantlist enrichment');
            
            // Fetch full release data for each item to get ratings, have/want, videos
            const totalItems = data.wants.length;
            tbody.innerHTML = `<tr><td colspan="15" class="text-center py-5">
                <div class="spinner-border" role="status"></div>
                <p class="mt-2 mb-1">Enriching wantlist data...</p>
                <p class="mb-0" id="enrichProgress"><strong>0 / ${totalItems}</strong> (0%)</p>
            </td></tr>`;
            
            const wantlistReleases = [];
            for (let i = 0; i < data.wants.length; i++) {
                const item = data.wants[i];
                const release = item.basic_information;
            
            try {
                // Fetch full release data
                const fullRelease = await makeDiscogsRequest(`https://api.discogs.com/releases/${release.id}`);
                
                const enrichedRelease = {
                    id: release.id,
                    title: fullRelease.title || release.title,
                    artist: release.artists?.map(a => a.name).join(', ') || '',
                    artist_title: fullRelease.title || release.title,
                    label: release.labels?.map(l => l.name).join(', ') || '',
                    year: fullRelease.year || release.year || '',
                    genres: JSON.stringify(fullRelease.genres || release.genres || []),
                    styles: JSON.stringify(fullRelease.styles || release.styles || []),
                    url: `https://www.discogs.com/release/${release.id}`,
                    avg_rating: fullRelease.community?.rating?.average || 0,
                    num_ratings: fullRelease.community?.rating?.count || 0,
                    seller_username: 'My Wantlist',
                    demand_coeff: fullRelease.community ? (fullRelease.community.want + 1) / (fullRelease.community.have + 1) : 0,
                    have_count: fullRelease.community?.have || 0,
                    want_count: fullRelease.community?.want || 0,
                    price: 0,
                    video_urls: JSON.stringify(fullRelease.videos || []),
                    bayesian_score: fullRelease.community?.rating?.average || 0,
                    notes: item.notes || '',
                    inWantlist: true // Mark as in wantlist
                };
                
                wantlistReleases.push(enrichedRelease);
            } catch (error) {
                console.error(`Failed to fetch full data for release ${release.id}:`, error);
                // Fallback to basic data
                wantlistReleases.push({
                    id: release.id,
                    title: release.title,
                    artist: release.artists?.map(a => a.name).join(', ') || '',
                    artist_title: release.title,
                    label: release.labels?.map(l => l.name).join(', ') || '',
                    year: release.year || '',
                    genres: JSON.stringify(release.genres || []),
                    styles: JSON.stringify(release.styles || []),
                    url: `https://www.discogs.com/release/${release.id}`,
                    avg_rating: 0,
                    num_ratings: 0,
                    seller_username: 'My Wantlist',
                    demand_coeff: 0,
                    have_count: 0,
                    want_count: 0,
                    price: 0,
                    video_urls: JSON.stringify([]),
                    bayesian_score: 0,
                    notes: item.notes || '',
                    inWantlist: true
                });
            }
            
            // Update progress
            const progressEl = document.getElementById('enrichProgress');
            if (progressEl) {
                const completed = i + 1;
                const percentage = Math.round((completed / totalItems) * 100);
                progressEl.innerHTML = `<strong>${completed} / ${totalItems}</strong> (${percentage}%)`;
                }
            }
            
            // Cache the enriched data and save IDs
            cachedWantlistData = wantlistReleases;
            lastWantlistIds = currentWantlistIds;
            saveWantlistCache();
            
            // Display in table
            allData = wantlistReleases;
            hasSearched = true;
            displayResults(wantlistReleases, false);
        }
        
    } catch (error) {
        console.error('Failed to fetch wantlist:', error);
        tbody.innerHTML = '<tr><td colspan="15" class="text-center py-5"><div class="alert alert-danger">Failed to load wantlist. Please try again.</div></td></tr>';
    }
}

// Toggle release in wantlist (add or remove)
async function toggleWantlist(releaseId, buttonElement) {
    if (!oauthUser || !userAccessToken) {
        alert('Please log in with Discogs to manage your wantlist.');
        return;
    }
    
    const isInWantlist = userWantlistIds.has(releaseId);
    
    try {
        const username = oauthUser.username;
        const wantlistUrl = `https://api.discogs.com/users/${username}/wants/${releaseId}`;

		// Optional proxy to work around Discogs CORS (set `discogs_proxy_url` in localStorage)
		const proxyBase = localStorage.getItem('discogs_proxy_url') || '';
		const useProxy = Boolean(proxyBase);
		const targetUrl = useProxy ? `${proxyBase}?url=${encodeURIComponent(wantlistUrl)}` : wantlistUrl;
		const baseHeaders = useProxy
			? {
				'X-Forward-Authorization': `Discogs token=${userAccessToken}`,
				'X-Forward-User-Agent': 'DiscogsTrackr/1.0'
			}
			: {
				'Authorization': `Discogs token=${userAccessToken}`,
				'User-Agent': 'DiscogsTrackr/1.0'
			};

		if (isInWantlist) {
			// Remove from wantlist
			const response = await fetch(targetUrl, {
				method: 'DELETE',
				headers: baseHeaders
			});
            
                if (response.status === 204) {
                    // Successfully removed
                    userWantlistIds.delete(releaseId);
                    
                    // Update cached data
                    if (cachedCollectionData) {
                        const item = cachedCollectionData.find(r => r.id === releaseId);
                        if (item) item.inWantlist = false;
                        saveCollectionCache();
                    }
                    if (cachedWantlistData) {
                        // Remove from cached wantlist
                        cachedWantlistData = cachedWantlistData.filter(r => r.id !== releaseId);
                        lastWantlistIds.delete(releaseId);
                        saveWantlistCache();
                    }
                    
                    if (buttonElement) {
                        buttonElement.innerHTML = '<i class="bi bi-eye" style="color: #fff;"></i>';
                        buttonElement.onclick = () => toggleWantlist(releaseId, buttonElement);
                    }
                    
                    // If we're viewing wantlist, refresh the display
                    if (currentView === 'wantlist') {
                        showUserWantlist();
                    }
                } else {
                    throw new Error(`Failed to remove from wantlist: ${response.status}`);
                }
		} else {
			// Add to wantlist
			const response = await fetch(targetUrl, {
				method: 'PUT',
				headers: baseHeaders
			});
            
            if (response.status === 201 || response.status === 204) {
                // Successfully added
                userWantlistIds.add(releaseId);
                
                // Update cached data
                if (cachedCollectionData) {
                    const item = cachedCollectionData.find(r => r.id === releaseId);
                    if (item) {
                        item.inWantlist = true;
                        saveCollectionCache();
                    }
                }
                
                if (buttonElement) {
                    buttonElement.innerHTML = '<i class="bi bi-eye-fill" style="color: var(--accent-color);"></i>';
                    buttonElement.onclick = () => toggleWantlist(releaseId, buttonElement);
                }
            } else {
                throw new Error(`Failed to add to wantlist: ${response.status}`);
            }
        }
        
    } catch (error) {
        console.error('Failed to update wantlist:', error);
        alert('Failed to update wantlist. Please try again.');
    }
}

// ==================== DISCOGS API CALLS ====================
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 1100; // Slightly over 1 second for safety
let requestCount = 0;
let requestWindowStart = Date.now();
const MAX_REQUESTS_PER_MINUTE = 55; // More conservative limit (Discogs allows 60)

// Simplified rate limiter - just tracks timing, no complex promise chaining
async function waitForRateLimit() {
    const now = Date.now();
    
    // Reset counter if we're in a new minute window
    if (now - requestWindowStart >= 60000) {
        requestCount = 0;
        requestWindowStart = now;
    }
    
    // If we've hit the per-minute limit, wait until the next window
    if (requestCount >= MAX_REQUESTS_PER_MINUTE) {
        const waitTime = 60000 - (now - requestWindowStart) + 1000; // Add 1s buffer
        if (waitTime > 0) {
            console.log(`Rate limit: waiting ${Math.ceil(waitTime / 1000)}s before next request`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            requestCount = 0;
            requestWindowStart = Date.now();
        }
    }
    
    // Ensure minimum interval between requests
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
        await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest));
    }
}

// Fetch with timeout
async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error('Request timeout');
        }
        throw error;
    }
}

// Retry utility with exponential backoff
async function retryWithBackoff(fn, options = {}) {
    const {
        maxRetries = 3,
        baseDelay = 2000,
        maxDelay = 60000,
        onRetry = null
    } = options;
    
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            
            // Don't retry on certain errors
            if (error.message.includes('credentials not configured') ||
                error.message.includes('404') ||
                error.message.includes('400')) {
                throw error;
            }
            
            // If it's the last attempt, throw
            if (attempt === maxRetries) {
                throw error;
            }
            
            // Calculate backoff with exponential increase
            const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
            
            // For rate limit errors, use the suggested wait time
            if (error.message.includes('429')) {
                const match = error.message.match(/wait (\d+) seconds/);
                const suggestedWait = match ? parseInt(match[1]) * 1000 : delay;
                if (onRetry) onRetry(attempt + 1, suggestedWait, error.message);
                await new Promise(resolve => setTimeout(resolve, suggestedWait));
            } else if (error.message.includes('403')) {
                // Aggressive backoff for 403
                const wait403 = Math.min(delay * 3, maxDelay);
                if (onRetry) onRetry(attempt + 1, wait403, 'Forbidden (rate limit)');
                await new Promise(resolve => setTimeout(resolve, wait403));
            } else {
                if (onRetry) onRetry(attempt + 1, delay, error.message);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    
    throw lastError;
}

// Main API request function - simplified and robust
async function makeDiscogsRequest(url, options = {}) {
    const consumerKey = localStorage.getItem('discogs_consumer_key');
    const consumerSecret = localStorage.getItem('discogs_consumer_secret');
    if (!consumerKey || !consumerSecret) {
        throw new Error('Discogs credentials not configured. Please go to Settings.');
    }
    
    const { skipRateLimit = false, retries = 3 } = options;
    
    return await retryWithBackoff(async () => {
        // Wait for rate limit unless explicitly skipped
        if (!skipRateLimit) {
            await waitForRateLimit();
        }
        
        // Build URL and headers
        const proxyBase = localStorage.getItem('discogs_proxy_url') || '';
        const useProxy = Boolean(proxyBase);
        const targetUrl = useProxy 
            ? `${proxyBase}?url=${encodeURIComponent(url)}`
            : `${url}${url.includes('?') ? '&' : '?'}key=${consumerKey}&secret=${consumerSecret}`;
        
        const headers = useProxy
            ? {
                'X-Forward-Discogs-Key': consumerKey,
                'X-Forward-Discogs-Secret': consumerSecret,
                'X-Forward-User-Agent': 'DiscogsSellerApp/1.0',
                'Accept': 'application/json'
            }
            : {
                'User-Agent': 'DiscogsSellerApp/1.0',
                'Accept': 'application/json'
            };
        
        // Make request with timeout
        const response = await fetchWithTimeout(targetUrl, { headers }, 30000);
        
        // Update rate limit tracking
        lastRequestTime = Date.now();
        requestCount++;
        
        // Handle error responses
        if (response.status === 429) {
            const retryAfter = parseInt(response.headers.get('Retry-After') || '60');
            throw new Error(`Rate limited (429). Please wait ${retryAfter} seconds.`);
        }
        
        if (response.status === 403) {
            throw new Error('Forbidden (403). Likely rate limited by Discogs.');
        }
        
        if (response.status === 404) {
            throw new Error(`Not found (404): ${url}`);
        }
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        return await response.json();
    }, { 
        maxRetries: retries,
        baseDelay: 2000,
        maxDelay: 120000
    });
}

async function getSellerInventory(username, page = 1, perPage = 100) {
    const url = `https://api.discogs.com/users/${username}/inventory?page=${page}&per_page=${perPage}`;
    return await makeDiscogsRequest(url);
}

async function getReleaseDetails(releaseId) {
    const url = `https://api.discogs.com/releases/${releaseId}`;
    return await makeDiscogsRequest(url);
}

// ==================== JOB MANAGEMENT ====================
function checkForStoredJob() {
    const storedJobId = localStorage.getItem('currentJobId');
    const storedUsername = localStorage.getItem('currentUsername');
    
    if (storedJobId && storedUsername) {
        currentJobId = storedJobId;
        
        const job = getJobFromStorage(storedJobId);
        if (job && job.status === 'processing') {
            // Update seller's currentJob
            const seller = trackedSellers.find(s => s.username === storedUsername);
            if (seller) {
                seller.currentJob = job;
                updateSellerList();
            }
            resumeJob(storedJobId, storedUsername);
        } else if (job && job.status === 'complete') {
            localStorage.removeItem('currentJobId');
            localStorage.removeItem('currentUsername');
        }
    }
}

function createJob(jobId, username) {
    const job = {
        jobId,
        username,
        status: 'processing',
        progress: 0,
        total: 0,
        currentStep: 'Initializing...',
        createdAt: Date.now()
    };
    try {
        localStorage.setItem(`job_${jobId}`, JSON.stringify(job));
    } catch (e) {
        console.error('Failed to store job in localStorage:', e);
        // Try emergency cleanup and retry once
        if (e.name === 'QuotaExceededError') {
            console.log('Attempting emergency cleanup...');
            if (aggressiveCleanupLocalStorage()) {
                try {
                    localStorage.setItem(`job_${jobId}`, JSON.stringify(job));
                    console.log('Job stored after cleanup');
                } catch (e2) {
                    console.error('Still failed after cleanup:', e2);
                }
            }
        }
    }
    return job;
}

function updateJob(jobId, updates) {
    const jobStr = localStorage.getItem(`job_${jobId}`);
    if (!jobStr) return null;
    
    const job = JSON.parse(jobStr);
    // Don't store processedReleases array to avoid quota issues
    if (updates.processedReleases) {
        delete updates.processedReleases;
    }
    Object.assign(job, updates);
    try {
        localStorage.setItem(`job_${jobId}`, JSON.stringify(job));
    } catch (e) {
        console.error('Failed to update job in localStorage (quota exceeded):', e);
        // Job will continue in memory even if we can't persist it
    }
    return job;
}

function getJobFromStorage(jobId) {
    const jobStr = localStorage.getItem(`job_${jobId}`);
    return jobStr ? JSON.parse(jobStr) : null;
}

// ==================== MAIN FETCH LOGIC ====================
// Fetch inventory only (for new sellers or when inventory needs refresh)
async function fetchSellerInventory(username) {
    const seller = trackedSellers.find(s => s.username === username);
    if (!seller) return;
    
    const jobId = 'job_' + Date.now();
    currentJobId = jobId;
    
    try {
        localStorage.setItem('currentJobId', jobId);
        localStorage.setItem('currentUsername', username);
    } catch (e) {
        console.warn('Could not store job metadata in localStorage:', e);
    }
    
    const job = createJob(jobId, username);
    seller.currentJob = job;
    updateSellerList();
    
    await fetchInventoryOnly(jobId, username);
}

// Process releases from cached inventory (incremental)
async function processSellerReleases(username) {
    const seller = trackedSellers.find(s => s.username === username);
    if (!seller) return;
    
    if (!seller.inventory || seller.inventory.length === 0) {
        alert('No inventory cached. Please fetch inventory first.');
        return;
    }
    
    const jobId = 'job_' + Date.now();
    currentJobId = jobId;
    
    try {
        localStorage.setItem('currentJobId', jobId);
        localStorage.setItem('currentUsername', username);
    } catch (e) {
        console.warn('Could not store job metadata in localStorage:', e);
    }
    
    const job = createJob(jobId, username);
    seller.currentJob = job;
    updateSellerList();
    
    await processReleasesFromInventory(jobId, username);
}

// Legacy function for backward compatibility (fetches inventory then processes)
async function fetchSellerData(username, forceRefresh = false) {
    if (forceRefresh) {
        await fetchSellerInventory(username);
    } else {
        await processSellerReleases(username);
    }
}

// Fetch inventory only - no release processing
async function fetchInventoryOnly(jobId, username) {
    try {
        const seller = trackedSellers.find(s => s.username === username);
        if (!seller) return;
        
        // Store fetched inventory in compact normalized form
        let allListings = [];
        updateJob(jobId, { currentStep: 'Fetching inventory...' });
        updateProgress(jobId);
        
        let page = 1;
        const perPage = 100;
        const maxPages = 100; // Discogs pagination limit
        
        while (page <= maxPages) {
            try {
                const inventory = await getSellerInventory(username, page, perPage);
                const listings = inventory.listings || [];
                
                if (listings.length === 0) break;

                // Store only compact normalized listings to reduce DB size
                allListings.push(...listings.map(normalizeListingForInventory));
                
                const totalPages = Math.min(inventory.pagination?.pages || 1, maxPages);
                updateJob(jobId, {
                    currentStep: `Fetching inventory: Page ${page} of ${totalPages}`,
                    progress: page,
                    total: totalPages
                });
                updateProgress(jobId);
                
                if (page >= totalPages) break;
                page++;
            } catch (error) {
                console.error(`Error fetching inventory page ${page}:`, error);
                
                // If we've already got some data, continue with what we have
                if (allListings.length > 0) {
                    console.log(`Continuing with ${allListings.length} items fetched so far`);
                    break;
                }
                
                // Otherwise, this is a fatal error
                throw error;
            }
        }
            
        // Save inventory (already compact normalized listings)
        seller.inventory = allListings;
        await saveSellerDataToDB(seller);
        
        if (allListings.length === 0) {
            updateJob(jobId, {
                status: 'error',
                currentStep: 'No listings found for this seller'
            });
            updateProgress(jobId);
            finishJob(jobId, username);
            return;
        }
        
        // Complete inventory fetch
        seller.lastUpdated = Date.now();
        saveTrackedSellers();
        updateJob(jobId, {
            status: 'complete',
            currentStep: `Inventory fetched: ${allListings.length} items. Click refresh again to process releases.`
        });
        updateProgress(jobId);
        finishJob(jobId, username);
        
    } catch (error) {
        console.error('Error fetching inventory:', error);
        updateJob(jobId, {
            status: 'error',
            currentStep: `Error: ${error.message}`
        });
        updateProgress(jobId);
        finishJob(jobId, username);
    }
}

// Process releases from cached inventory (batch of 50)
async function processReleasesFromInventory(jobId, username) {
    try {
        const seller = trackedSellers.find(s => s.username === username);
        if (!seller) return;
        
        const allListings = seller.inventory || [];
        
        if (allListings.length === 0) {
            updateJob(jobId, {
                status: 'error',
                currentStep: 'No inventory cached'
            });
            updateProgress(jobId);
            finishJob(jobId, username);
            return;
        }
        
        updateJob(jobId, { currentStep: 'Analyzing inventory...' });
        updateProgress(jobId);
        
        // Process unique releases (supports both legacy and compact inventory)
        const uniqueReleases = {};
        for (const listing of allListings) {
            const info = getListingInfoFromInventory(listing);
            if (!info || !info.releaseId) continue;

            const price = info.price || 0;
            const releaseId = info.releaseId;

            if (!uniqueReleases[releaseId] || (price > 0 && price < uniqueReleases[releaseId].price)) {
                uniqueReleases[releaseId] = {
                    id: releaseId,
                    artist: info.artist || 'Unknown Artist',
                    title: info.title || 'Unknown Title',
                    price: price
                };
            }
        }
        
        const releaseIds = Object.keys(uniqueReleases);
        
        // Check which releases we already have details for
        const existingReleases = seller.releases || [];
        const existingIds = new Set(existingReleases.map(r => r.id));
        const newReleaseIds = releaseIds.filter(id => !existingIds.has(parseInt(id)));
        const removedIds = existingReleases.filter(r => !releaseIds.includes(r.id.toString())).map(r => r.id);
        
        // Remove releases no longer in inventory
        if (removedIds.length > 0) {
            seller.releases = existingReleases.filter(r => !removedIds.includes(r.id));
            console.log(`Removed ${removedIds.length} releases no longer in inventory`);
            await saveSellerDataToDB(seller);
        }
        
        // If no new releases, we're done
        if (newReleaseIds.length === 0) {
            updateJob(jobId, {
                status: 'complete',
                currentStep: 'All releases up to date!',
                progress: releaseIds.length,
                total: releaseIds.length
            });
            updateProgress(jobId);
            
            seller.lastUpdated = Date.now();
            saveTrackedSellers();
            await saveSellerDataToDB(seller);
            updateSellerList();
            if (currentView === 'sellers') {
                loadAllSellersData();
            }
            finishJob(jobId, username);
            return;
        }
        
        updateJob(jobId, {
            total: newReleaseIds.length,
            progress: 0,
            currentStep: `Fetching details for ${newReleaseIds.length} new releases...`
        });
        updateProgress(jobId);
        
        // Fetch details for all new releases with automatic rate limit handling
        const processedReleases = [...existingReleases];
        let failedReleases = 0;
        
        for (let i = 0; i < newReleaseIds.length; i++) {
            const job = getJobFromStorage(jobId);
            if (job && job.status === 'cancelled') {
                console.log('Job cancelled');
                return;
            }
            
            const releaseId = newReleaseIds[i];
            const basicInfo = uniqueReleases[releaseId];
            
            try {
                const details = await getReleaseDetails(releaseId);
                
                const ratingData = details.community?.rating || {};
                const avgRating = parseFloat(ratingData.average || 0);
                const numRatings = parseInt(ratingData.count || 0);
                const bayesianScore = bayesianRating(avgRating, numRatings);
                
                const haveCount = parseInt(details.community?.have || 0);
                const wantCount = parseInt(details.community?.want || 0);
                
                const releaseData = {
                    id: parseInt(releaseId),
                    artist_title: `${basicInfo.artist} - ${basicInfo.title}`,
                    artist: details.artists?.[0]?.name || basicInfo.artist,
                    title: details.title || basicInfo.title,
                    label: details.labels?.[0]?.name || null,
                    year: details.year || null,
                    genres: JSON.stringify(details.genres || []),
                    styles: JSON.stringify(details.styles || []),
                    avg_rating: avgRating,
                    num_ratings: numRatings,
                    bayesian_score: bayesianScore,
                    price: basicInfo.price,
                    condition: basicInfo.condition || '',
                    have_count: haveCount,
                    want_count: wantCount,
                    youtube_video_id: null,
                    video_urls: JSON.stringify(details.videos || []),
                    url: `https://www.discogs.com/release/${releaseId}`,
                    demand_coeff: computeRarityCoeff(haveCount, wantCount)
                };
                
                processedReleases.push(releaseData);
                
                updateJob(jobId, {
                    progress: i + 1,
                    currentStep: `Processing: ${i + 1} of ${newReleaseIds.length} new releases`
                });
                updateProgress(jobId);
                
                // Update seller data incrementally
                seller.releases = processedReleases;
                
                // Update display every 10 releases
                if ((i + 1) % 10 === 0 || i === newReleaseIds.length - 1) {
                    await saveSellerDataToDB(seller);
                    if (currentView === 'sellers') {
                        loadAllSellersData();
                    }
                }
                
            } catch (error) {
                console.error(`Error fetching details for release ${releaseId}:`, error);
                failedReleases++;
                
                // If too many failures, stop processing but save what we have
                if (failedReleases >= 10) {
                    console.warn(`Too many failures (${failedReleases}), stopping processing`);
                    seller.releases = processedReleases;
                    await saveSellerDataToDB(seller);
                    
                    updateJob(jobId, { 
                        status: 'complete', 
                        currentStep: `Processed ${processedReleases.length - existingReleases.length} new releases (stopped due to errors)` 
                    });
                    updateProgress(jobId);
                    seller.lastUpdated = Date.now();
                    saveTrackedSellers();
                    finishJob(jobId, username);
                    return;
                }
                
                // Skip this release and continue
                console.warn(`Skipping release ${releaseId}, will continue with next`);
            }
        }
        
        seller.lastUpdated = Date.now();
        saveTrackedSellers();
        await saveSellerDataToDB(seller);
        updateSellerList();
        
        updateJob(jobId, {
            status: 'complete',
            currentStep: `Complete! Processed ${processedReleases.length} releases.`,
            progress: newReleaseIds.length
        });
        updateProgress(jobId);
        
        if (currentView === 'sellers') {
            loadAllSellersData();
        }
        finishJob(jobId, username);
        
    } catch (error) {
        console.error('Error processing releases:', error);
        updateJob(jobId, {
            status: 'error',
            currentStep: `Error: ${error.message}`
        });
        updateProgress(jobId);
        finishJob(jobId, username);
    }
}

async function resumeJob(jobId, username) {
    const job = getJobFromStorage(jobId);
    if (!job) return;
    
    // Resume processing releases from cached inventory
    updateProgress(jobId);
    
    await processReleasesFromInventory(jobId, username);
}

function updateProgress(jobId) {
    const job = getJobFromStorage(jobId);
    if (!job) return;
    
    // Update the seller's currentJob
    const username = job.username || job.seller_username;
    if (username) {
        const seller = trackedSellers.find(s => s.username === username);
        if (seller) {
            seller.currentJob = job;
            updateSellerList();
        }
    }
}

function isProcessingActive() {
    try {
        return Array.isArray(trackedSellers) && trackedSellers.some(s => s && s.currentJob && s.currentJob.status === 'processing');
    } catch (e) {
        return false;
    }
}

function cancelJob(jobId, event) {
    if (event) {
        event.stopPropagation();
    }
    
    if (!confirm('Are you sure you want to cancel this job?')) {
        return;
    }
    
    const job = updateJob(jobId, {
        status: 'cancelled',
        currentStep: 'Cancelled by user'
    });
    
    const username = job?.username || job?.seller_username;
    finishJob(jobId, username);
}

function finishJob(jobId, username) {
    const job = getJobFromStorage(jobId);
    const sellerUsername = username || job?.username || job?.seller_username;
    
    if (sellerUsername) {
        const seller = trackedSellers.find(s => s.username === sellerUsername);
        if (seller) {
            if (job && job.status === 'complete') {
                // Clear the job after a short delay
                setTimeout(() => {
                    seller.currentJob = null;
                    updateSellerList();
                }, 2000);
            } else if (job && job.status === 'cancelled') {
                // Keep cancelled status visible briefly
                seller.currentJob = job;
                updateSellerList();
                setTimeout(() => {
                    seller.currentJob = null;
                    updateSellerList();
                }, 2000);
            } else {
                seller.currentJob = null;
                updateSellerList();
            }
        }
    }
    
    localStorage.removeItem('currentJobId');
    localStorage.removeItem('currentUsername');
    localStorage.removeItem(`job_${jobId}`);
}

// ==================== DISPLAY & FILTERING ====================
let lastDataHash = '';

function displayResults(releases, isProcessing = false) {
    const currentHash = JSON.stringify(releases.map(r => r.id + '-' + r.artist_title));
    const hasNewData = currentHash !== lastDataHash;
    
    if (hasNewData || !isProcessing) {
        lastDataHash = currentHash;
        
        allData = releases.map(r => ({
            ...r,
            demand_coeff: computeRarityCoeff(r.have_count, r.want_count)
        }));
        
        if (!isProcessing) {
            populateFilterOptions(allData);
        }
        
        const savePage = isProcessing ? currentPage : 1;
        applyFilters(savePage);
    }
    
    if (isProcessing) {
        const resultsSection = document.getElementById('resultsSection');
        if (resultsSection) {
            const existingNote = document.getElementById('processingNote');
            if (!existingNote) {
                const note = document.createElement('div');
                note.id = 'processingNote';
                note.className = 'alert alert-info mt-2';
                note.innerHTML = '<i class="bi bi-hourglass-split"></i> Still processing... Results will update automatically.';
                resultsSection.insertBefore(note, resultsSection.firstChild);
            }
        }
    } else {
        const existingNote = document.getElementById('processingNote');
        if (existingNote) {
            existingNote.remove();
        }
        lastDataHash = '';
    }
}

// ==================== MULTI-SELECT FILTER STATE ====================
const FILTER_STATE_KEY = 'discogsTrackr_filterState';
let multiSelectFilters = {
    genre: [],
    style: [],
    artist: [],
    label: []
};

// Load cached filter state
function loadFilterState() {
    try {
        const cached = localStorage.getItem(FILTER_STATE_KEY);
        if (cached) {
            const parsed = JSON.parse(cached);
            multiSelectFilters = {
                genre: parsed.genre || [],
                style: parsed.style || [],
                artist: parsed.artist || [],
                label: parsed.label || []
            };
        }
    } catch (e) {
        console.warn('Failed to load filter state:', e);
    }
}

// Save filter state to localStorage
function saveFilterState() {
    try {
        localStorage.setItem(FILTER_STATE_KEY, JSON.stringify(multiSelectFilters));
    } catch (e) {
        console.warn('Failed to save filter state:', e);
    }
}

// ==================== MULTI-SELECT DROPDOWN COMPONENT ====================
class MultiSelectDropdown {
    constructor(selectElement, filterKey, placeholder) {
        this.selectElement = selectElement;
        this.filterKey = filterKey;
        this.placeholder = placeholder;
        this.options = [];
        this.selectedValues = new Set(multiSelectFilters[filterKey] || []);
        this.container = null;
        this.trigger = null;
        this.dropdown = null;
        
        this.init();
    }
    
    init() {
        if (!this.selectElement || !this.selectElement.parentNode) {
            console.error('Select element or parent not found for', this.filterKey);
            return;
        }
        
        // Hide original select but keep it in DOM for form submission if needed
        this.selectElement.style.display = 'none';
        this.selectElement.style.visibility = 'hidden';
        this.selectElement.style.position = 'absolute';
        this.selectElement.style.opacity = '0';
        this.selectElement.style.pointerEvents = 'none';
        this.selectElement.style.width = '0';
        this.selectElement.style.height = '0';
        this.selectElement.style.margin = '0';
        this.selectElement.style.padding = '0';
        
        // Create multi-select container
        this.container = document.createElement('div');
        this.container.className = 'multi-select-container';
        
        // Create trigger button
        this.trigger = document.createElement('div');
        this.trigger.className = 'multi-select-trigger';
        this.trigger.tabIndex = 0;
        this.trigger.setAttribute('role', 'button');
        this.trigger.setAttribute('aria-haspopup', 'listbox');
        this.updateTriggerText();
        
        // Create dropdown
        this.dropdown = document.createElement('div');
        this.dropdown.className = 'multi-select-dropdown';
        this.dropdown.setAttribute('role', 'listbox');
        
        // Add to DOM - replace the select element's position
        this.container.appendChild(this.trigger);
        this.container.appendChild(this.dropdown);
        
        // Insert container right after the select element
        const parent = this.selectElement.parentNode;
        if (this.selectElement.nextSibling) {
            parent.insertBefore(this.container, this.selectElement.nextSibling);
        } else {
            parent.appendChild(this.container);
        }
        
        // Verify container is in DOM and visible
        if (!document.body.contains(this.container)) {
            console.error('Container not added to DOM for', this.filterKey);
        }
        
        // Force visibility
        this.container.style.display = 'block';
        this.container.style.visibility = 'visible';
        this.trigger.style.display = 'flex';
        this.trigger.style.visibility = 'visible';
        
        // Event listeners
        this.trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            // Close all other dropdowns before toggling this one
            closeAllDropdowns(this);
            this.toggle();
        });
        
        this.trigger.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.toggle();
            }
        });
        
        // Store handlers for cleanup if needed
        this.clickHandler = null;
        this.scrollHandler = null;
    }
    
    toggle() {
        if (this.dropdown.classList.contains('open')) {
            this.close();
        } else {
            this.open();
        }
    }
    
    open() {
        // Close all other dropdowns first
        closeAllDropdowns(this);
        
        // Calculate position relative to trigger
        const triggerRect = this.trigger.getBoundingClientRect();
        const dropdown = this.dropdown;
        
        dropdown.style.position = 'fixed';
        dropdown.style.top = (triggerRect.bottom + 4) + 'px';
        dropdown.style.left = triggerRect.left + 'px';
        dropdown.style.width = triggerRect.width + 'px';
        dropdown.style.maxWidth = triggerRect.width + 'px';
        
        this.dropdown.classList.add('open');
        this.trigger.classList.add('open');
        
        // Force display
        this.dropdown.style.display = 'block';
        this.dropdown.style.visibility = 'visible';
        this.dropdown.style.zIndex = '99999';
        
        // Add click outside handler
        setTimeout(() => {
            this.clickHandler = (e) => {
                if (!this.container.contains(e.target) && !this.dropdown.contains(e.target)) {
                    this.close();
                }
            };
            document.addEventListener('click', this.clickHandler);
            
            // Close on page scroll (but not when scrolling inside the dropdown)
            this.scrollHandler = (e) => {
                if (!this.dropdown.classList.contains('open')) {
                    return;
                }
                
                // Check if the scroll event originated from inside the dropdown
                const target = e.target;
                if (target && (this.dropdown.contains(target) || this.container.contains(target))) {
                    // Scroll is happening inside the dropdown, don't close
                    return;
                }
                
                // Only close if scrolling the window/document itself
                // This happens when the page scrolls, not when scrolling inside elements
                if (target === window || target === document || target === document.documentElement || target === document.body) {
                    this.close();
                }
            };
            // Listen to scroll events on window (page scroll)
            window.addEventListener('scroll', this.scrollHandler, false);
        }, 0);
    }
    
    close() {
        if (!this.dropdown || !this.dropdown.classList.contains('open')) {
            return; // Already closed
        }
        
        this.dropdown.classList.remove('open');
        this.trigger.classList.remove('open');
        this.dropdown.style.display = 'none';
        
        // Remove event listeners
        if (this.clickHandler) {
            document.removeEventListener('click', this.clickHandler);
            this.clickHandler = null;
        }
        if (this.scrollHandler) {
            window.removeEventListener('scroll', this.scrollHandler, false);
            this.scrollHandler = null;
        }
        
        // Reset positioning
        this.dropdown.style.position = '';
        this.dropdown.style.top = '';
        this.dropdown.style.left = '';
        this.dropdown.style.width = '';
    }
    
    updateTriggerText() {
        if (!this.trigger) return;
        
        const count = this.selectedValues.size;
        this.trigger.innerHTML = '';
        
        if (count === 0) {
            const textNode = document.createTextNode(this.placeholder);
            this.trigger.appendChild(textNode);
        } else {
            const textNode = document.createTextNode(this.placeholder + ' ');
            const countSpan = document.createElement('span');
            countSpan.className = 'multi-select-count';
            countSpan.textContent = count;
            this.trigger.appendChild(textNode);
            this.trigger.appendChild(countSpan);
        }
        
        // Ensure trigger is visible
        if (this.trigger.style) {
            this.trigger.style.display = 'flex';
            this.trigger.style.visibility = 'visible';
            this.trigger.style.opacity = '1';
        }
    }
    
    populate(counts) {
        this.options = Array.from(counts.entries())
            .sort((a, b) => {
                if (b[1] !== a[1]) return b[1] - a[1];
                return a[0].localeCompare(b[0]);
            });
        
        this.render();
    }
    
    render() {
        if (!this.dropdown) return;
        
        this.dropdown.innerHTML = '';
        
        // If no options, show a message
        if (this.options.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.className = 'multi-select-option';
            emptyMsg.style.padding = '12px';
            emptyMsg.style.textAlign = 'center';
            emptyMsg.style.color = 'var(--text-color)';
            emptyMsg.style.opacity = '0.7';
            emptyMsg.textContent = 'No options available';
            this.dropdown.appendChild(emptyMsg);
            return;
        }
        
        // Add Select All / Clear All buttons
        const actions = document.createElement('div');
        actions.className = 'multi-select-actions';
        
        const selectAllBtn = document.createElement('button');
        selectAllBtn.textContent = 'Select All';
        selectAllBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.selectAll();
        });
        
        const clearAllBtn = document.createElement('button');
        clearAllBtn.textContent = 'Clear All';
        clearAllBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.clearAll();
        });
        
        actions.appendChild(selectAllBtn);
        actions.appendChild(clearAllBtn);
        this.dropdown.appendChild(actions);
        
        // Add options
        const optionsContainer = document.createElement('div');
        optionsContainer.className = 'multi-select-options';
        
        this.options.forEach(([value, count]) => {
            const option = document.createElement('div');
            option.className = 'multi-select-option';
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `${this.filterKey}-${value}`;
            checkbox.value = value;
            checkbox.checked = this.selectedValues.has(value);
            
            const label = document.createElement('label');
            label.htmlFor = checkbox.id;
            label.textContent = `${value} (${count})`;
            
            checkbox.addEventListener('change', (e) => {
                e.stopPropagation();
                if (checkbox.checked) {
                    this.selectedValues.add(value);
                } else {
                    this.selectedValues.delete(value);
                }
                this.updateSelection();
            });
            
            option.addEventListener('click', (e) => {
                if (e.target !== checkbox) {
                    checkbox.checked = !checkbox.checked;
                    checkbox.dispatchEvent(new Event('change'));
                }
            });
            
            option.appendChild(checkbox);
            option.appendChild(label);
            optionsContainer.appendChild(option);
        });
        
        this.dropdown.appendChild(optionsContainer);
    }
    
    selectAll() {
        this.selectedValues.clear();
        this.options.forEach(([value]) => {
            this.selectedValues.add(value);
        });
        this.render();
        this.updateSelection();
    }
    
    clearAll() {
        this.selectedValues.clear();
        this.render();
        this.updateSelection();
    }
    
    updateSelection() {
        multiSelectFilters[this.filterKey] = Array.from(this.selectedValues);
        this.updateTriggerText();
        saveFilterState();
        applyFilters();
    }
    
    getSelectedValues() {
        return Array.from(this.selectedValues);
    }
}

// Initialize multi-select dropdowns
let genreDropdown, styleDropdown, artistDropdown, labelDropdown;
const allDropdowns = [];

// Function to close all open dropdowns
function closeAllDropdowns(excludeDropdown = null) {
    allDropdowns.forEach(dropdown => {
        if (dropdown !== excludeDropdown && dropdown.dropdown && dropdown.dropdown.classList.contains('open')) {
            dropdown.close();
        }
    });
}

function initMultiSelectDropdowns() {
    const genreSelect = document.getElementById('genre');
    const styleSelect = document.getElementById('style');
    const artistSelect = document.getElementById('artist');
    const labelSelect = document.getElementById('label');
    
    if (!genreSelect || !styleSelect || !artistSelect || !labelSelect) {
        console.warn('Filter select elements not found, retrying...');
        setTimeout(initMultiSelectDropdowns, 100);
        return;
    }
    
    try {
        genreDropdown = new MultiSelectDropdown(genreSelect, 'genre', 'All Genres');
        styleDropdown = new MultiSelectDropdown(styleSelect, 'style', 'All Styles');
        artistDropdown = new MultiSelectDropdown(artistSelect, 'artist', 'All Artists');
        labelDropdown = new MultiSelectDropdown(labelSelect, 'label', 'All Labels');
        
        // Store references
        allDropdowns.push(genreDropdown, styleDropdown, artistDropdown, labelDropdown);
        
        console.log('Multi-select dropdowns initialized successfully');
    } catch (error) {
        console.error('Error initializing multi-select dropdowns:', error);
    }
}

function populateFilterOptions(releases) {
    const genreCounts = new Map();
    const styleCounts = new Map();
    const artistCounts = new Map();
    const labelCounts = new Map();
    
    releases.forEach(release => {
        if (release.genres) {
            try {
                const genres = JSON.parse(release.genres);
                genres.forEach(g => {
                    genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
                });
            } catch (e) {}
        }
        
        if (release.styles) {
            try {
                const styles = JSON.parse(release.styles);
                styles.forEach(s => {
                    styleCounts.set(s, (styleCounts.get(s) || 0) + 1);
                });
            } catch (e) {}
        }
        
        if (release.artist) {
            const artists = release.artist.split(/[,&\/]/).map(a => a.trim()).filter(a => a);
            artists.forEach(a => {
                artistCounts.set(a, (artistCounts.get(a) || 0) + 1);
            });
        }
        
        if (release.label) {
            const labels = release.label.split(/[,&\/]/).map(l => l.trim()).filter(l => l);
            labels.forEach(l => {
                labelCounts.set(l, (labelCounts.get(l) || 0) + 1);
            });
        }
    });
    
    // Populate multi-select dropdowns
    if (genreDropdown) genreDropdown.populate(genreCounts);
    if (styleDropdown) styleDropdown.populate(styleCounts);
    if (artistDropdown) artistDropdown.populate(artistCounts);
    if (labelDropdown) labelDropdown.populate(labelCounts);
}

function applyFilters(preservePage = null) {
    // Read from navbar search; fallback to legacy input if present
    const q = ((document.getElementById('navSearchInput')?.value) || (document.getElementById('text_search')?.value) || '').toLowerCase().trim();
    
    // Get multi-select values (OR logic)
    const selectedGenres = multiSelectFilters.genre || [];
    const selectedStyles = multiSelectFilters.style || [];
    const selectedArtists = multiSelectFilters.artist || [];
    const selectedLabels = multiSelectFilters.label || [];
    
    const yearRange = document.getElementById('year_range').value;
    const ratingRange = document.getElementById('rating_range').value;
    const ratingCountRange = document.getElementById('rating_count_range').value;
    const priceRange = document.getElementById('price_range') ? document.getElementById('price_range').value : '';
    const wantRange = document.getElementById('want_range') ? document.getElementById('want_range').value : '';
    
    let minYear = 0, maxYear = 9999;
    if (yearRange && yearRange.includes('-')) {
        const parts = yearRange.split('-');
        minYear = parseInt(parts[0]) || 0;
        maxYear = parseInt(parts[1]) || 9999;
    }
    
    let minRating = 0, maxRating = 5;
    if (ratingRange && ratingRange.includes('-')) {
        const parts = ratingRange.split('-');
        minRating = parseFloat(parts[0]) || 0;
        maxRating = parseFloat(parts[1]) || 5;
    }
    
    let minRatingCount = 0, maxRatingCount = Infinity;
    if (ratingCountRange && ratingCountRange.includes('-')) {
        const parts = ratingCountRange.split('-');
        minRatingCount = parseInt(parts[0]) || 0;
        maxRatingCount = parseInt(parts[1]) || Infinity;
    }
    
    let minPrice = 0, maxPrice = Infinity;
    if (priceRange && priceRange.includes('-')) {
        const parts = priceRange.split('-');
        minPrice = parseFloat(parts[0]) || 0;
        maxPrice = parseFloat(parts[1]) || Infinity;
    }
    
    let minWant = 0, maxWant = Infinity;
    if (wantRange && wantRange.includes('-')) {
        const parts = wantRange.split('-');
        minWant = parseInt(parts[0]) || 0;
        maxWant = parseInt(parts[1]) || Infinity;
    }
    
    filteredData = allData.filter(release => {
        if (selectedSellers.length > 0 && !selectedSellers.includes(release.seller_username)) {
            return false;
        }
        if (q) {
            // Build a comprehensive haystack across common fields
            let genresStr = '';
            let stylesStr = '';
            try { if (release.genres) genresStr = JSON.parse(release.genres).join(' '); } catch (e) {}
            try { if (release.styles) stylesStr = JSON.parse(release.styles).join(' '); } catch (e) {}
            const hay = (
                (release.title || release.artist_title || '') + ' ' +
                (release.artist || '') + ' ' +
                (release.label || '') + ' ' +
                genresStr + ' ' + stylesStr + ' ' +
                (release.seller_username || '')
            ).toLowerCase();
            if (!hay.includes(q)) return false;
        }
        
        // OR logic for genres: if any genres are selected, release must match at least one
        if (selectedGenres.length > 0) {
            let genres = [];
            if (release.genres) {
                try {
                    genres = JSON.parse(release.genres);
                } catch (e) {}
            }
            const hasMatch = selectedGenres.some(selectedGenre => genres.includes(selectedGenre));
            if (!hasMatch) return false;
        }
        
        // OR logic for styles: if any styles are selected, release must match at least one
        if (selectedStyles.length > 0) {
            let styles = [];
            if (release.styles) {
                try {
                    styles = JSON.parse(release.styles);
                } catch (e) {}
            }
            const hasMatch = selectedStyles.some(selectedStyle => styles.includes(selectedStyle));
            if (!hasMatch) return false;
        }
        
        // OR logic for artists: if any artists are selected, release must match at least one
        if (selectedArtists.length > 0) {
            if (!release.artist) return false;
            const artists = release.artist.split(/[,&\/]/).map(a => a.trim());
            const hasMatch = selectedArtists.some(selectedArtist => artists.includes(selectedArtist));
            if (!hasMatch) return false;
        }
        
        // OR logic for labels: if any labels are selected, release must match at least one
        if (selectedLabels.length > 0) {
            if (!release.label) return false;
            const labels = release.label.split(/[,&\/]/).map(l => l.trim());
            const hasMatch = selectedLabels.some(selectedLabel => labels.includes(selectedLabel));
            if (!hasMatch) return false;
        }
        
        if (release.year && (release.year < minYear || release.year > maxYear)) {
            return false;
        }
        
        if (release.avg_rating < minRating || release.avg_rating > maxRating) {
            return false;
        }
        
        if (release.num_ratings < minRatingCount || release.num_ratings > maxRatingCount) {
            return false;
        }
        
        const priceVal = typeof release.price === 'number' ? release.price : parseFloat(release.price) || 0;
        if (priceVal < minPrice || priceVal > maxPrice) {
            return false;
        }
        
        const wantVal = typeof release.want_count === 'number' ? release.want_count : parseInt(release.want_count) || 0;
        if (wantVal < minWant || wantVal > maxWant) {
            return false;
        }
        
        return true;
    });
    
    sortData();
    
    totalRecords = filteredData.length;
    if (preservePage !== null) {
        currentPage = Math.min(preservePage, Math.ceil(totalRecords / pageSize)) || 1;
    } else {
        currentPage = 1;
    }
    totalPages = Math.ceil(totalRecords / pageSize);
    
    renderTable();
    renderPagination();
}

function clearAllFilters() {
    // Clear multi-select filters
    multiSelectFilters = {
        genre: [],
        style: [],
        artist: [],
        label: []
    };
    
    // Clear dropdown selections
    if (genreDropdown) {
        genreDropdown.selectedValues.clear();
        genreDropdown.updateTriggerText();
        genreDropdown.render();
    }
    if (styleDropdown) {
        styleDropdown.selectedValues.clear();
        styleDropdown.updateTriggerText();
        styleDropdown.render();
    }
    if (artistDropdown) {
        artistDropdown.selectedValues.clear();
        artistDropdown.updateTriggerText();
        artistDropdown.render();
    }
    if (labelDropdown) {
        labelDropdown.selectedValues.clear();
        labelDropdown.updateTriggerText();
        labelDropdown.render();
    }
    
    // Clear range inputs
    document.getElementById('year_range').value = '';
    document.getElementById('rating_range').value = '';
    document.getElementById('rating_count_range').value = '';
    const priceRangeEl = document.getElementById('price_range');
    if (priceRangeEl) priceRangeEl.value = '';
    const wantRangeEl = document.getElementById('want_range');
    if (wantRangeEl) wantRangeEl.value = '';
    
    // Clear navbar search
    const navSearch = document.getElementById('navSearchInput');
    if (navSearch) navSearch.value = '';
    
    // Save state and apply filters
    saveFilterState();
    applyFilters();
}

function sortData() {
    if (!currentSort.column) return;
    
    filteredData.sort((a, b) => {
        let aVal = a[currentSort.column];
        let bVal = b[currentSort.column];
        
        if (aVal === null || aVal === undefined) aVal = '';
        if (bVal === null || bVal === undefined) bVal = '';
        
        if (typeof aVal === 'number' && typeof bVal === 'number') {
            return currentSort.direction === 'asc' ? aVal - bVal : bVal - aVal;
        }
        
        aVal = String(aVal).toLowerCase();
        bVal = String(bVal).toLowerCase();
        
        if (currentSort.direction === 'asc') {
            return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
        } else {
            return bVal < aVal ? -1 : bVal > aVal ? 1 : 0;
        }
    });
}

function sortByColumn(column) {
    if (currentSort.column === column) {
        currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
        currentSort.column = column;
        currentSort.direction = 'desc';
    }
    
    applyFilters(currentPage);
    updateSortIndicators();
}

// ==================== TABLE RENDERING ====================
function renderTable() {
    const tbody = document.getElementById('releases-table-body');
    if (!tbody) return;
    
    setupTableHeaders();
    updateSortIndicators();
    
    if (filteredData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="15" class="text-center">No releases found</td></tr>';
        return;
    }
    
    // Ensure any placeholder/no-results rows are removed when we have data
    Array.from(tbody.querySelectorAll('tr')).forEach(tr => {
        if (!tr.hasAttribute('data-release-id') || tr.querySelector('.no-results')) {
            tr.remove();
        }
    });

    const processingActive = isProcessingActive();
    const start = (currentPage - 1) * pageSize;
    const end = Math.min(start + pageSize, filteredData.length);
    const pageData = filteredData.slice(start, end);

    // Preserve existing rows to avoid reloading iframes
    const existingRows = new Map();
    tbody.querySelectorAll('tr[data-release-id]').forEach((row) => {
        const rid = row.getAttribute('data-release-id');
        if (rid) existingRows.set(rid, row);
    });

    if (!processingActive) {
        // Normal behavior: keep only rows for the current page and in correct order
        const currentPageIds = new Set(pageData.map(r => String(r.id)));
        existingRows.forEach((row, rid) => {
            if (!currentPageIds.has(rid)) {
                row.remove();
                existingRows.delete(rid);
            } else {
                row.style.display = '';
            }
        });
        // Append rows in order
        pageData.forEach((release) => {
            const idStr = String(release.id);
            let row = existingRows.get(idStr);
            if (!row) {
                row = document.createElement('tr');
                row.setAttribute('data-release-id', idStr);
                renderRow(row, release);
            } else {
                // Update existing row only if data has changed
                updateRowIfNeeded(row, release);
            }
            tbody.appendChild(row);
        });
    } else {
        // Processing: do not remove or reorder existing rows; just hide/show to reflect filters
        const currentPageIds = new Set(pageData.map(r => String(r.id)));
        existingRows.forEach((row, rid) => {
            if (currentPageIds.has(rid)) {
                row.style.display = '';
                // Update the row data if it changed, but preserve iframes
                const release = pageData.find(r => String(r.id) === rid);
                if (release) {
                    updateRowIfNeeded(row, release);
                }
            } else {
                row.style.display = 'none';
            }
        });
        // Create rows that are needed but not yet present (append at end)
        pageData.forEach((release) => {
            const idStr = String(release.id);
            if (!existingRows.has(idStr)) {
                const row = document.createElement('tr');
                row.setAttribute('data-release-id', idStr);
                renderRow(row, release);
                tbody.appendChild(row);
            }
        });
    }
    
    document.getElementById('resultsSection').style.display = 'block';
}

// Function to update a row only if data has changed, preserving iframes
function formatConditionAbbrev(raw) {
    if (!raw || typeof raw !== 'string') return '';
    const s = raw.trim();
    // Prefer abbreviation inside parentheses if available
    const paren = s.match(/\(([^)]+)\)/);
    if (paren && /\b(M|NM|VG\+?|G\+?|F|P)\b/i.test(paren[1])) {
        const token = paren[1].match(/(M|NM|VG\+?|G\+?|F|P)/i)[1].toUpperCase();
        // Normalize M- to NM
        return token === 'M-' ? 'NM' : token;
    }
    // Map common verbose strings
    const map = [
        [/^(mint)\b/i, 'M'],
        [/(near\s*mint|nm|m-)\b/i, 'NM'],
        [/vg\s*\+|very\s*good\s*\+/i, 'VG+'],
        [/\bvg\b|very\s*good(?!\s*\+)/i, 'VG'],
        [/g\s*\+|good\s*\+/i, 'G+'],
        [/\bg\b|\bgood\b/i, 'G'],
        [/\bfair\b|\bf\b/i, 'F'],
        [/\bpoor\b|\bp\b/i, 'P']
    ];
    for (const [re, abbr] of map) {
        if (re.test(s)) return abbr;
    }
    return s.toUpperCase();
}

function getReleaseCondition(release) {
    const direct = (
        release?.media_condition ||
        release?.condition ||
        release?.item_condition ||
        release?.condition_grade ||
        ''
    );
    if (direct && typeof direct === 'string') return direct;
    // Fallback: find any property containing 'condition'
    try {
        for (const key of Object.keys(release || {})) {
            if (key.toLowerCase().includes('condition')) {
                const val = release[key];
                if (typeof val === 'string' && val.trim()) {
                    return val;
                }
            }
        }
    } catch (e) {}
    return '';
}

function formatPrice(value) {
    if (value == null) return '-';
    // If release.price is a number
    if (typeof value === 'number') {
        return '$' + value.toFixed(2);
    }
    // If object with value/currency
    if (typeof value === 'object') {
        if (typeof value.formatted === 'string' && value.formatted.trim()) {
            return value.formatted;
        }
        if (typeof value.value === 'number') {
            const curr = value.currency || value.curr_abbr || '';
            if (curr) return `${curr === 'EUR' ? 'â‚¬' : curr === 'USD' ? '$' : curr} ${value.value.toFixed(2)}`;
            return value.value.toFixed(2);
        }
    }
    // Fallback: string
    if (typeof value === 'string' && value.trim()) return value;
    return '-';
}

function updateRowIfNeeded(row, release) {
    // Store the release data as a JSON string for comparison
    const newDataHash = JSON.stringify({
        title: release.title,
        artist: release.artist,
        label: release.label,
        year: release.year,
        genres: release.genres,
        styles: release.styles,
        avg_rating: release.avg_rating,
        num_ratings: release.num_ratings,
        seller_username: release.seller_username,
        demand_coeff: release.demand_coeff,
        have_count: release.have_count,
        want_count: release.want_count,
        price: release.price,
        video_urls: release.video_urls,
        media_condition: release.media_condition,
        condition: release.condition,
        item_condition: release.item_condition,
        condition_grade: release.condition_grade
    });
    
    const oldDataHash = row.getAttribute('data-release-hash');
    
    // If data hasn't changed, skip update
    if (oldDataHash === newDataHash) {
        return;
    }
    
    // Store the new hash
    row.setAttribute('data-release-hash', newDataHash);
    
    const isMobile = window.innerWidth <= 768;
    
    if (isMobile) {
        // For mobile, we need to update the entire cell content except for the iframe
        // Get existing iframe if it exists
        const existingIframe = row.querySelector('iframe');
        const existingPreview = row.querySelector('.mobile-preview');
        
        // Re-render the row
        row.innerHTML = '';
        renderRow(row, release);
        
        // If there was an iframe and it's the same video, restore it to avoid reload
        if (existingIframe && existingPreview) {
            const newPreview = row.querySelector('.mobile-preview');
            if (newPreview && newPreview.querySelector('iframe')) {
                const newIframe = newPreview.querySelector('iframe');
                // Compare src without query parameters
                const oldSrc = existingIframe.src.split('?')[0];
                const newSrc = newIframe.src.split('?')[0];
                if (oldSrc === newSrc) {
                    // Same video, restore the old iframe to preserve state
                    newIframe.replaceWith(existingIframe);
                }
            }
        }
    } else {
        // For desktop, just re-render the entire row to avoid column mismatch issues
        // The previous approach with hardcoded cell indices breaks when switching views
        row.innerHTML = '';
        renderRow(row, release);
    }
}

function renderNewRow(release) {
    const row = document.createElement('tr');
    renderRow(row, release);
    return row;
}

function updateExistingRowOld_DEPRECATED(row, release) {
    // OLD VERSION - DEPRECATED - DO NOT USE
    // This had bugs with hardcoded cell indices
    const isMobile = window.innerWidth <= 768;
    
    if (isMobile) {
        // For mobile, we need to update the entire cell content except for the iframe
        // Get existing iframe if it exists
        const existingIframe = row.querySelector('iframe');
        const existingPreview = row.querySelector('.mobile-preview');
        
        // Re-render the row
        row.innerHTML = '';
        renderRow(row, release);
        
        // If there was an iframe and it's the same video, restore it to avoid reload
        if (existingIframe && existingPreview) {
            const newPreview = row.querySelector('.mobile-preview');
            if (newPreview && newPreview.querySelector('iframe')) {
                const newIframe = newPreview.querySelector('iframe');
                // Compare src without query parameters
                const oldSrc = existingIframe.src.split('?')[0];
                const newSrc = newIframe.src.split('?')[0];
                if (oldSrc === newSrc) {
                    // Same video, restore the old iframe to preserve state
                    newIframe.replaceWith(existingIframe);
                }
            }
        }
    } else {
        // For desktop, update individual cells without touching the video cell
        const cells = row.querySelectorAll('td');
        
        let genres = [];
        let styles = [];
        try {
            if (release.genres) genres = JSON.parse(release.genres);
            if (release.styles) styles = JSON.parse(release.styles);
        } catch (e) {}
        
        // Determine column indices based on current view
        let cellIndex = 0;
        const columnMap = {};
        
        // Common columns for all views
        columnMap.title = cellIndex++;
        columnMap.artist = cellIndex++;
        columnMap.label = cellIndex++;
        columnMap.year = cellIndex++;
        columnMap.genreStyle = cellIndex++;
        columnMap.rating = cellIndex++;
        
        // Seller column only in sellers view
        if (currentView === 'sellers') {
            columnMap.seller = cellIndex++;
        }
        
        // Common columns continue
        columnMap.rarity = cellIndex++;
        columnMap.numRatings = cellIndex++;
        columnMap.have = cellIndex++;
        columnMap.want = cellIndex++;
        
        // Price column only in sellers view
        if (currentView === 'sellers') {
            columnMap.price = cellIndex++;
        }
        
        // Actions column for sellers and wantlist
        if (currentView === 'sellers' || currentView === 'wantlist') {
            columnMap.actions = cellIndex++;
        }
        
        // Video column is always last
        columnMap.video = cellIndex++;
        
        // Update cells by mapped index
        // Title
        if (cells[columnMap.title]) {
            cells[columnMap.title].innerHTML = `
                <div class="title-cell">
                    <a href="${release.url}" target="_blank" class="release-link">${escapeHtml(release.title || release.artist_title)}</a>
                </div>
            `;
        }
        // Artist
        if (cells[columnMap.artist]) {
            cells[columnMap.artist].textContent = release.artist || '-';
        }
        // Label
        if (cells[columnMap.label]) {
            cells[columnMap.label].textContent = release.label || '-';
        }
        // Year
        if (cells[columnMap.year]) {
            cells[columnMap.year].textContent = release.year || '-';
        }
        // Genre/Style
        if (cells[columnMap.genreStyle]) {
            cells[columnMap.genreStyle].innerHTML = '';
            if (genres.length > 0) {
                genres.forEach(g => {
                    const span = document.createElement('span');
                    span.className = 'badge-genre';
                    span.textContent = g;
                    cells[columnMap.genreStyle].appendChild(span);
                });
            }
            if (styles.length > 0) {
                styles.forEach(s => {
                    const span = document.createElement('span');
                    span.className = 'badge-style';
                    span.textContent = s;
                    cells[columnMap.genreStyle].appendChild(span);
                });
            }
            if (genres.length === 0 && styles.length === 0) {
                cells[columnMap.genreStyle].textContent = '-';
            }
        }
        // Rating
        if (cells[columnMap.rating]) {
            const ratingStars = release.avg_rating ? generateStars(release.avg_rating) : '<div class="text-muted">No rating</div>';
            const ratingText = release.avg_rating ? `${parseFloat(release.avg_rating).toFixed(2)}${release.num_ratings ? ` (${release.num_ratings})` : ''}` : '';
            cells[columnMap.rating].innerHTML = `${ratingStars} ${ratingText}`;
        }
        // Seller (only in sellers view)
        if (columnMap.seller !== undefined && cells[columnMap.seller]) {
            cells[columnMap.seller].innerHTML = `<span class="badge bg-secondary">${escapeHtml(release.seller_username || '')}</span>`;
        }
        // Rarity
        if (cells[columnMap.rarity]) {
            cells[columnMap.rarity].textContent = release.demand_coeff ? parseFloat(release.demand_coeff).toFixed(2) : '-';
        }
        // # Ratings
        if (cells[columnMap.numRatings]) {
            cells[columnMap.numRatings].textContent = release.num_ratings || '0';
        }
        // Have
        if (cells[columnMap.have]) {
            cells[columnMap.have].textContent = release.have_count || '0';
        }
        // Want
        if (cells[columnMap.want]) {
            cells[columnMap.want].textContent = release.want_count || '0';
        }
        // Price (only in sellers view)
        if (columnMap.price !== undefined && cells[columnMap.price]) {
            const priceConditionAbbr = formatConditionAbbrev(getReleaseCondition(release));
            const priceText = formatPrice(release.price);
            cells[columnMap.price].innerHTML = `
                <div class="price-cell" style="display:inline-block; position:relative; min-width: 64px;">
                    <span class="price-text">${priceText}</span>
                    ${priceConditionAbbr ? `<span class=\"badge-condition\">${priceConditionAbbr}</span>` : ''}
                </div>
            `;
        }
        // Actions (only in sellers and wantlist views)
        if (columnMap.actions !== undefined && cells[columnMap.actions]) {
            const heartIcon = release.inWantlist 
                ? '<i class="bi bi-eye-fill" style="color: var(--accent-color);"></i>'
                : '<i class="bi bi-eye" style="color: #fff;"></i>';
            const titleText = release.inWantlist ? 'Remove from Wantlist' : 'Add to Wantlist';
            cells[columnMap.actions].innerHTML = `
                <button class="wantlist-heart-btn" onclick="toggleWantlist(${release.id}, this)" title="${titleText}">
                    ${heartIcon}
                </button>
            `;
        }
        // Video - only update if video URLs have changed
        if (cells[columnMap.video]) {
            const existingCarousel = cells[12].querySelector('.video-carousel');
            const existingIframe = existingCarousel ? existingCarousel.querySelector('iframe') : null;
            
            let rawVideoLinks = [];
            if (release.video_urls) {
                try {
                    rawVideoLinks = JSON.parse(release.video_urls);
                } catch (e) {}
            }
            const videoLinks = sanitizeVideoLinks(rawVideoLinks);
            
            // Check if video URLs are the same
            let shouldUpdateVideo = true;
            if (existingCarousel) {
                const carouselVideosAttr = existingCarousel.querySelector('.video-nav-btn')?.getAttribute('data-videos');
                if (carouselVideosAttr) {
                    try {
                        const existingVideos = JSON.parse(decodeURIComponent(carouselVideosAttr));
                        if (JSON.stringify(existingVideos) === JSON.stringify(videoLinks)) {
                            shouldUpdateVideo = false;
                        }
                    } catch (e) {}
                }
            }
            
            // Only update video cell if videos have changed
            if (shouldUpdateVideo) {
                let videoCell = '';
                if (videoLinks.length > 0) {
                    const firstVideo = videoLinks[0];
                    const firstVideoId = extractYouTubeID(firstVideo.url);
                    
                    if (firstVideoId) {
                        const videosDataAttr = encodeURIComponent(JSON.stringify(videoLinks));
                        videoCell = `
                            <div class="video-carousel" id="carousel-${release.id}" data-release-id="${release.id}">
                                <iframe id="youtube-player-${release.id}" class="table-iframe" loading="lazy" 
                                    title="YouTube video player" aria-label="YouTube video player" 
                                    src="https://www.youtube.com/embed/${firstVideoId}?enablejsapi=1&rel=0&modestbranding=1" 
                                    frameborder="0" 
                                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
                                    allowfullscreen 
                                    style="width: 220px; height: 124px;">
                                </iframe>
                        `;
                        
                        if (videoLinks.length > 1) {
                            videoCell += `
                                <div class="video-nav d-flex justify-content-between align-items-center mt-1">
                                    <button class="btn btn-sm btn-outline-secondary video-nav-btn" data-release-id="${release.id}" data-direction="-1" data-videos="${videosDataAttr}">
                                        <i class="bi bi-chevron-left"></i>
                                    </button>
                                    <span class="video-counter" id="counter-${release.id}">1 / ${videoLinks.length}</span>
                                    <button class="btn btn-sm btn-outline-secondary video-nav-btn" data-release-id="${release.id}" data-direction="1" data-videos="${videosDataAttr}">
                                        <i class="bi bi-chevron-right"></i>
                                    </button>
                                </div>
                            `;
                        }
                        videoCell += '</div>';
                    } else {
                        const linksToShow = videoLinks.slice(0, 3);
                        if (linksToShow.length > 0) {
                            videoCell = '<div class="video-links">';
                            linksToShow.forEach((video, idx) => {
                                videoCell += `<a href="${escapeHtml(video.url)}" target="_blank" class="btn btn-sm btn-outline-primary mb-1" style="display: block; font-size: 0.75rem;">
                                    <i class="bi bi-play-circle"></i> ${escapeHtml(video.title || 'Video ' + (idx + 1))}
                                </a>`;
                            });
                            videoCell += '</div>';
                        }
                    }
                }
                
                if (!videoCell) {
                    videoCell = `
                        <a href="https://www.youtube.com/results?search_query=${encodeURIComponent((release.artist || '') + ' ' + (release.title || release.artist_title || ''))}" 
                           target="_blank" class="btn btn-sm btn-outline-secondary">
                            <i class="bi bi-search"></i> Search
                        </a>
                    `;
                }
                
                cells[12].innerHTML = videoCell;
            }
        }
    }
}

function renderRow(row, release) {
    // Store the release data hash for future comparisons
    const dataHash = JSON.stringify({
        title: release.title,
        artist: release.artist,
        label: release.label,
        year: release.year,
        genres: release.genres,
        styles: release.styles,
        avg_rating: release.avg_rating,
        num_ratings: release.num_ratings,
        seller_username: release.seller_username,
        demand_coeff: release.demand_coeff,
        have_count: release.have_count,
        want_count: release.want_count,
        price: release.price,
        video_urls: release.video_urls
    });
    row.setAttribute('data-release-hash', dataHash);
    
    const isMobile = window.innerWidth <= 768;
    
    let genres = [];
    let styles = [];
    try {
        if (release.genres) genres = JSON.parse(release.genres);
        if (release.styles) styles = JSON.parse(release.styles);
    } catch (e) {}
    
    // Video cell
    let videoCell = '';
    let rawVideoLinks = [];
    
    if (release.video_urls) {
        try {
            rawVideoLinks = JSON.parse(release.video_urls);
        } catch (e) {}
    }
    
    const videoLinks = sanitizeVideoLinks(rawVideoLinks);
    
    if (isMobile) {
        // Mobile layout: single cell with all content
        let previewContent = '';
        if (videoLinks.length > 0) {
            const firstVideo = videoLinks[0];
            const firstVideoId = extractYouTubeID(firstVideo.url);
            if (firstVideoId) {
                previewContent = `<div class="mobile-preview">
                    <iframe id="youtube-player-${release.id}" loading="lazy" 
                        title="YouTube video player" aria-label="YouTube video player" 
                        src="https://www.youtube.com/embed/${firstVideoId}?enablejsapi=1&rel=0&modestbranding=1" 
                        frameborder="0" 
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
                        allowfullscreen
                        style="width: 100%; height: auto; aspect-ratio: 16 / 9;"></iframe>
                </div>`;
            } else {
                previewContent = '<div class="mobile-preview text-muted">Invalid YouTube link</div>';
            }
        } else {
            previewContent = '<div class="mobile-preview text-muted">No YouTube links</div>';
        }
        
        const titleDiv = document.createElement('div');
        titleDiv.className = 'mobile-title';
        const titleLink = document.createElement('a');
        titleLink.href = release.url;
        titleLink.target = '_blank';
        titleLink.className = 'release-link';
        titleLink.textContent = release.title || release.artist_title;
        titleDiv.appendChild(titleLink);
        
        const ratingDiv = document.createElement('div');
        ratingDiv.className = 'mobile-rating';
        if (release.avg_rating) {
            ratingDiv.innerHTML = `${generateStars(release.avg_rating)} ${parseFloat(release.avg_rating).toFixed(2)}${release.num_ratings ? ` (${release.num_ratings})` : ''}`;
        } else {
            ratingDiv.innerHTML = '<div class="text-muted">No rating</div>';
        }
        
        // Additional info
        const infoDiv = document.createElement('div');
        infoDiv.style.fontSize = '12px';
        infoDiv.style.opacity = '0.8';
        infoDiv.style.marginTop = '8px';
        let infoText = [];
        if (release.artist) infoText.push(`Artist: ${release.artist}`);
        if (release.label) infoText.push(`Label: ${release.label}`);
        if (release.year) infoText.push(`Year: ${release.year}`);
        if (release.price) infoText.push(`Price: $${release.price.toFixed(2)}`);
        if (release.seller_username) infoText.push(`Seller: ${release.seller_username}`);
        infoDiv.textContent = infoText.join(' â€¢ ');
        
        const tdMobile = document.createElement('td');
        tdMobile.className = 'mobile-cell';
        tdMobile.innerHTML = previewContent;
        tdMobile.appendChild(titleDiv);
        tdMobile.appendChild(ratingDiv);
        tdMobile.appendChild(infoDiv);
        
        // Add genre/style badges if available
        if (genres.length > 0 || styles.length > 0) {
            const badgesDiv = document.createElement('div');
            badgesDiv.style.marginTop = '8px';
            genres.forEach(g => {
                const span = document.createElement('span');
                span.className = 'badge-genre';
                span.textContent = g;
                badgesDiv.appendChild(span);
            });
            styles.forEach(s => {
                const span = document.createElement('span');
                span.className = 'badge-style';
                span.textContent = s;
                badgesDiv.appendChild(span);
            });
            tdMobile.appendChild(badgesDiv);
        }
        
        row.appendChild(tdMobile);
    } else {
        // Desktop layout: multiple columns
        const genreStyleCell = document.createElement('td');
        if (genres.length > 0) {
            genres.forEach(g => {
                const span = document.createElement('span');
                span.className = 'badge-genre';
                span.textContent = g;
                genreStyleCell.appendChild(span);
            });
        }
        if (styles.length > 0) {
            styles.forEach(s => {
                const span = document.createElement('span');
                span.className = 'badge-style';
                span.textContent = s;
                genreStyleCell.appendChild(span);
            });
        }
        if (genres.length === 0 && styles.length === 0) {
            genreStyleCell.textContent = '-';
        }
        
        if (videoLinks.length > 0) {
            const firstVideo = videoLinks[0];
            const firstVideoId = extractYouTubeID(firstVideo.url);
            
            if (firstVideoId) {
                const videosDataAttr = encodeURIComponent(JSON.stringify(videoLinks));
                videoCell = `
                    <div class="video-carousel" id="carousel-${release.id}" data-release-id="${release.id}">
                        <iframe id="youtube-player-${release.id}" class="table-iframe" loading="lazy" 
                            title="YouTube video player" aria-label="YouTube video player" 
                            src="https://www.youtube.com/embed/${firstVideoId}?enablejsapi=1&rel=0&modestbranding=1" 
                            frameborder="0" 
                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
                            allowfullscreen 
                            style="width: 220px; height: 124px;">
                        </iframe>
                `;
                
                if (videoLinks.length > 1) {
                    videoCell += `
                        <div class="video-nav d-flex justify-content-between align-items-center mt-1">
                            <button class="btn btn-sm btn-outline-secondary video-nav-btn" data-release-id="${release.id}" data-direction="-1" data-videos="${videosDataAttr}">
                                <i class="bi bi-chevron-left"></i>
                            </button>
                            <span class="video-counter" id="counter-${release.id}">1 / ${videoLinks.length}</span>
                            <button class="btn btn-sm btn-outline-secondary video-nav-btn" data-release-id="${release.id}" data-direction="1" data-videos="${videosDataAttr}">
                                <i class="bi bi-chevron-right"></i>
                            </button>
                        </div>
                    `;
                }
                videoCell += '</div>';
            } else {
                const linksToShow = videoLinks.slice(0, 3);
                if (linksToShow.length > 0) {
                    videoCell = '<div class="video-links">';
                    linksToShow.forEach((video, idx) => {
                        videoCell += `<a href="${escapeHtml(video.url)}" target="_blank" class="btn btn-sm btn-outline-primary mb-1" style="display: block; font-size: 0.75rem;">
                            <i class="bi bi-play-circle"></i> ${escapeHtml(video.title || 'Video ' + (idx + 1))}
                        </a>`;
                    });
                    videoCell += '</div>';
                }
            }
        }
        
        if (!videoCell) {
            videoCell = `
                <a href="https://www.youtube.com/results?search_query=${encodeURIComponent((release.artist || '') + ' ' + (release.title || release.artist_title || ''))}" 
                   target="_blank" class="btn btn-sm btn-outline-secondary">
                    <i class="bi bi-search"></i> Search
                </a>
            `;
        }
        
        const ratingStars = release.avg_rating ? generateStars(release.avg_rating) : '<div class="text-muted">No rating</div>';
        const ratingText = release.avg_rating ? `${parseFloat(release.avg_rating).toFixed(2)}${release.num_ratings ? ` (${release.num_ratings})` : ''}` : '';
        
        // Basic columns always shown
        row.innerHTML = `
            <td>
                <div class="title-cell">
                    <a href="${release.url}" target="_blank" class="release-link">${escapeHtml(release.title || release.artist_title)}</a>
                </div>
            </td>
            <td>${escapeHtml(release.artist || '-')}</td>
            <td>${escapeHtml(release.label || '-')}</td>
            <td class="text-center">${release.year || '-'}</td>
        `;
        row.appendChild(genreStyleCell);
        
        // Rating and community stats columns (shown in all views)
        row.innerHTML += `<td class="text-center">${ratingStars} ${ratingText}</td>`;
        
        // Seller column only for sellers view
        if (currentView === 'sellers') {
            row.innerHTML += `<td class="text-center"><span class="badge bg-secondary">${escapeHtml(release.seller_username || '')}</span></td>`;
        }
        
        // Community stats (shown in all views)
        row.innerHTML += `
            <td class="text-center">${release.demand_coeff ? parseFloat(release.demand_coeff).toFixed(2) : '-'}</td>
            <td class="text-center">${release.num_ratings || '0'}</td>
            <td class="text-center">${release.have_count || '0'}</td>
            <td class="text-center">${release.want_count || '0'}</td>
        `;
        
        // Price column only for sellers view
        if (currentView === 'sellers') {
            const priceConditionAbbr = formatConditionAbbrev(getReleaseCondition(release));
            row.innerHTML += `
                <td class="text-center"><div class="price-cell" style="display:inline-block; position:relative; min-width: 64px;">
                    <span class="price-text">${formatPrice(release.price)}</span>
                    ${priceConditionAbbr ? `<span class="badge-condition">${priceConditionAbbr}</span>` : ''}
                </div></td>
            `;
        }
        
        // Actions column for sellers and wantlist views (before videos)
        if (currentView === 'sellers' || currentView === 'wantlist') {
            const heartIcon = release.inWantlist 
                ? '<i class="bi bi-eye-fill" style="color: var(--accent-color);"></i>'
                : '<i class="bi bi-eye" style="color: #fff;"></i>';
            const titleText = release.inWantlist ? 'Remove from Wantlist' : 'Add to Wantlist';
            
            row.innerHTML += `
                <td class="text-center">
                    <button class="wantlist-heart-btn" style="font-size: 1.25rem;" onclick="toggleWantlist(${release.id}, this)" title="${titleText}">
                        ${heartIcon}
                    </button>
                </td>
            `;
        }
        
        // Video column always shown (after actions)
        row.innerHTML += `<td class="text-center">${videoCell}</td>`;
    }
}

function setupTableHeaders() {
    const thead = document.getElementById('table-header');
    thead.innerHTML = ''; // Clear existing headers
    
    // Define which columns to show based on current view
    let columns;
    if (currentView === 'collection') {
        // Collection columns (no seller, no price, no actions)
        columns = [
            { key: 'title', label: 'Title' },
            { key: 'artist', label: 'Artist' },
            { key: 'label', label: 'Label' },
            { key: 'year', label: 'Year' },
            { key: null, label: 'Genre / Style', nosort: true },
            { key: 'bayesian_score', label: 'Rating' },
            { key: 'demand_coeff', label: 'Rarity' },
            { key: 'num_ratings', label: '# Ratings' },
            { key: 'have_count', label: 'Have' },
            { key: 'want_count', label: 'Want' },
            { key: null, label: 'Videos', nosort: true }
        ];
    } else if (currentView === 'wantlist') {
        // Wantlist columns (show actions to remove)
        columns = [
            { key: 'title', label: 'Title' },
            { key: 'artist', label: 'Artist' },
            { key: 'label', label: 'Label' },
            { key: 'year', label: 'Year' },
            { key: null, label: 'Genre / Style', nosort: true },
            { key: 'bayesian_score', label: 'Rating' },
            { key: 'demand_coeff', label: 'Rarity' },
            { key: 'num_ratings', label: '# Ratings' },
            { key: 'have_count', label: 'Have' },
            { key: 'want_count', label: 'Want' },
            { key: null, label: 'Actions', nosort: true },
            { key: null, label: 'Videos', nosort: true }
        ];
    } else {
        // Full columns for seller tracking view
        columns = [
            { key: 'title', label: 'Title' },
            { key: 'artist', label: 'Artist' },
            { key: 'label', label: 'Label' },
            { key: 'year', label: 'Year' },
            { key: null, label: 'Genre / Style', nosort: true },
            { key: 'bayesian_score', label: 'Rating' },
            { key: 'seller_username', label: 'Seller' },
            { key: 'demand_coeff', label: 'Rarity' },
            { key: 'num_ratings', label: '# Ratings' },
            { key: 'have_count', label: 'Have' },
            { key: 'want_count', label: 'Want' },
            { key: 'price', label: 'Price' },
            { key: null, label: 'Actions', nosort: true },
            { key: null, label: 'Videos', nosort: true }
        ];
    }
    
    const headerRow = document.createElement('tr');
    columns.forEach(col => {
        const th = document.createElement('th');
        th.setAttribute('data-column-name', col.label);
        
        if (col.key && !col.nosort) {
            th.setAttribute('data-sort-key', col.key);
            th.style.cursor = 'pointer';
            th.addEventListener('click', () => sortByColumn(col.key));
            th.innerHTML = col.label;
        } else {
            th.textContent = col.label;
        }
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
}

function updateSortIndicators() {
    const thead = document.getElementById('table-header');
    if (!thead) return;
    
    const ths = thead.querySelectorAll('th[data-sort-key]');
    ths.forEach(th => {
        const sortKey = th.getAttribute('data-sort-key');
        const colName = th.getAttribute('data-column-name');
        
        th.innerHTML = colName;
        
        if (sortKey && currentSort.column === sortKey) {
            const icon = currentSort.direction === 'asc' 
                ? '<i class="bi bi-arrow-up sort-indicator"></i>'
                : '<i class="bi bi-arrow-down sort-indicator"></i>';
            th.innerHTML += icon;
        }
    });
}

function generateStars(avg) {
    const average = parseFloat(avg) || 0;
    const full = Math.floor(average);
    const half = average % 1 >= 0.5 ? 1 : 0;
    const empty = 5 - full - half;
    let html = '';
    for (let i = 0; i < full; i++) html += '<i class="bi bi-star-fill text-warning"></i>';
    if (half) html += '<i class="bi bi-star-half text-warning"></i>';
    for (let i = 0; i < empty; i++) html += '<i class="bi bi-star text-warning"></i>';
    return html;
}

// ==================== PAGINATION ====================
function renderPagination() {
    const pagination = document.getElementById('pagination');
    pagination.innerHTML = '';
    
    if (totalPages <= 1) {
        pagination.style.display = 'none';
        return;
    }
    
    pagination.style.display = 'flex';
    
    const prevLi = document.createElement('li');
    prevLi.className = `page-item ${currentPage === 1 ? 'disabled' : ''}`;
    prevLi.innerHTML = `<a class="page-link" href="#" onclick="changePage(${currentPage - 1}); return false;">Previous</a>`;
    pagination.appendChild(prevLi);
    
    const maxButtons = 5;
    let startPage = Math.max(1, currentPage - Math.floor(maxButtons / 2));
    let endPage = Math.min(totalPages, startPage + maxButtons - 1);
    
    if (endPage - startPage < maxButtons - 1) {
        startPage = Math.max(1, endPage - maxButtons + 1);
    }
    
    for (let i = startPage; i <= endPage; i++) {
        const pageLi = document.createElement('li');
        pageLi.className = `page-item ${i === currentPage ? 'active' : ''}`;
        pageLi.innerHTML = `<a class="page-link" href="#" onclick="changePage(${i}); return false;">${i}</a>`;
        pagination.appendChild(pageLi);
    }
    
    const nextLi = document.createElement('li');
    nextLi.className = `page-item ${currentPage === totalPages ? 'disabled' : ''}`;
    nextLi.innerHTML = `<a class="page-link" href="#" onclick="changePage(${currentPage + 1}); return false;">Next</a>`;
    pagination.appendChild(nextLi);
}

function stopAllVideos() {
    // Stop all YouTube videos by sending stop command to all iframes
    const youtubeIframes = document.querySelectorAll('iframe[src*="youtube.com/embed"]');
    youtubeIframes.forEach(iframe => {
        try {
            // Send stop command via postMessage to YouTube iframe
            // YouTube iframes with enablejsapi=1 accept commands via postMessage
            iframe.contentWindow.postMessage('{"event":"command","func":"stopVideo","args":""}', 'https://www.youtube.com');
        } catch (e) {
            // If postMessage fails, try alternative approach
            try {
                // Try pausing by setting src to empty and restoring (forces reload)
                const currentSrc = iframe.src;
                if (currentSrc.includes('youtube.com/embed')) {
                    // Reload the iframe to stop playback
                    iframe.src = currentSrc.split('&autoplay=1').join('').split('?autoplay=1').join('?');
                }
            } catch (e2) {
                console.warn('Error stopping YouTube video:', e2);
            }
        }
    });
    
    // Also stop any YouTube player instances if they exist
    if (youtubePlayerInstances && typeof youtubePlayerInstances === 'object') {
        Object.values(youtubePlayerInstances).forEach(player => {
            try {
                if (player && typeof player.stopVideo === 'function') {
                    player.stopVideo();
                }
            } catch (e) {
                console.warn('Error stopping YouTube player:', e);
            }
        });
    }
}

function changePage(page) {
    if (page < 1 || page > totalPages) return;
    // Stop all video playback before changing page
    stopAllVideos();
    currentPage = page;
    renderTable();
    renderPagination();
}

// ==================== VIDEO CAROUSEL ====================
document.addEventListener('click', function(e) {
    if (e.target.closest('.video-nav-btn')) {
        const btn = e.target.closest('.video-nav-btn');
        const releaseId = parseInt(btn.getAttribute('data-release-id'), 10);
        const direction = parseInt(btn.getAttribute('data-direction'), 10);
        const videosJson = btn.getAttribute('data-videos');
        
        if (!Number.isInteger(releaseId) || !Number.isInteger(direction) || !videosJson) {
            return;
        }

        try {
            const videos = JSON.parse(decodeURIComponent(videosJson));
            changeVideo(releaseId, direction, videos);
        } catch (err) {
            console.error('Error parsing videos JSON:', err);
        }
    }
});

function changeVideo(releaseId, direction, videos) {
    if (!Array.isArray(videos) || videos.length === 0) {
        return;
    }

    if (!currentVideoIndex[releaseId]) {
        currentVideoIndex[releaseId] = 0;
    }
    
    currentVideoIndex[releaseId] += direction;
    if (currentVideoIndex[releaseId] < 0) {
        currentVideoIndex[releaseId] = videos.length - 1;
    } else if (currentVideoIndex[releaseId] >= videos.length) {
        currentVideoIndex[releaseId] = 0;
    }
    
    const currentIndex = currentVideoIndex[releaseId];
    const video = videos[currentIndex];
    const videoUrl = getVideoUrl(video);
    const videoId = extractYouTubeID(videoUrl);
    
    if (videoId) {
        const iframe = document.getElementById(`youtube-player-${releaseId}`);
        if (iframe) {
            iframe.src = `https://www.youtube.com/embed/${videoId}?enablejsapi=1&rel=0&modestbranding=1`;
        }
    }
    
    const counter = document.getElementById(`counter-${releaseId}`);
    if (counter) {
        counter.textContent = `${currentIndex + 1} / ${videos.length}`;
    }
}
