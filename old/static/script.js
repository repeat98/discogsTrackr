// Global state
let allData = [];
let filteredData = [];
let totalRecords = 0;
let currentPage = 1;
const pageSize = 10;
let totalPages = 1;
let currentJobId = null;
let pollInterval = null;
let youtubeApiReady = false;
let youtubePlayerInstances = {};
let currentSort = { column: 'bayesian_score', direction: 'desc' };
let hasSearched = false; // Track if a search has been performed

// YouTube API ready callback
function onYouTubeIframeAPIReady() {
    youtubeApiReady = true;
    initializeYouTubePlayers();
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
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

    // Filter change handlers
    document.getElementById('genre').addEventListener('change', applyFilters);
    document.getElementById('style').addEventListener('change', applyFilters);
    document.getElementById('artist').addEventListener('change', applyFilters);
    document.getElementById('label').addEventListener('change', applyFilters);
    document.getElementById('year_range').addEventListener('input', debounce(applyFilters, 500));
    document.getElementById('rating_range').addEventListener('input', debounce(applyFilters, 500));
    document.getElementById('rating_count_range').addEventListener('input', debounce(applyFilters, 500));
    const priceRangeEl = document.getElementById('price_range');
    if (priceRangeEl) priceRangeEl.addEventListener('input', debounce(applyFilters, 500));
    
    // Check for stored job on page load
    checkForStoredJob();
});

// Check if there's a job in progress from localStorage
async function checkForStoredJob() {
    const storedJobId = localStorage.getItem('currentJobId');
    const storedUsername = localStorage.getItem('currentUsername');
    
    if (storedJobId && storedUsername) {
        document.getElementById('sellerInput').value = storedUsername;
        currentJobId = storedJobId;
        
        // Show progress section immediately
        document.getElementById('progressSection').classList.add('active');
        document.getElementById('statusMessage').textContent = 'Checking job status...';
        
        // Check if job is still active
        try {
            const response = await fetch(`${getApiUrl()}/api/job/${storedJobId}`);
            const result = await response.json();
            
            if (result.error || result.job.status === 'complete' || result.job.status === 'error') {
                // Job is done or doesn't exist, clear storage
                localStorage.removeItem('currentJobId');
                localStorage.removeItem('currentUsername');
                
                // If complete, show the data
                if (result.job && result.job.status === 'complete' && result.data) {
                    displayResults(result.data.releases, false);
                    document.getElementById('progressSection').classList.remove('active');
                }
            } else {
                // Job is still running, start polling
                startPolling();
            }
        } catch (error) {
            console.error('Error checking stored job:', error);
            localStorage.removeItem('currentJobId');
            localStorage.removeItem('currentUsername');
        }
    }
}

// Debounce helper
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

// Determine API base URL
function getApiUrl() {
    return window.location.hostname === 'localhost' 
        ? 'http://localhost:5000'
        : window.location.origin;
}

// Fetch releases from seller
async function fetchReleases() {
    const sellerInput = document.getElementById('sellerInput');
    const sellerUsername = sellerInput.value.trim();

    if (!sellerUsername) {
        alert('Please enter a seller username');
        return;
    }

    hasSearched = true; // Mark that a search has been performed

    // Stop any existing polling
    stopPolling();

    // Reset UI
    document.getElementById('progressSection').classList.add('active');
    document.getElementById('progressBar').style.width = '0%';
    document.getElementById('progressBar').textContent = '0%';
    document.getElementById('fetchButton').disabled = true;
    document.getElementById('fetchButton').innerHTML = '<span class="spinner-border spinner-border-sm"></span> Loading...';
    document.getElementById('statusMessage').textContent = 'Checking for cached data...';

    try {
        // Request seller data
        const response = await fetch(`${getApiUrl()}/api/seller/${encodeURIComponent(sellerUsername)}`);
        const result = await response.json();

        if (result.status === 'cached') {
            // We have cached data
            document.getElementById('statusMessage').textContent = 'Loaded from cache!';
            displayResults(result.data.releases);
            document.getElementById('fetchButton').disabled = false;
            document.getElementById('fetchButton').innerHTML = '<i class="bi bi-search"></i> Search';
            
            // Show refresh button
            showRefreshOption(sellerUsername);
        } else if (result.status === 'started' || result.status === 'processing') {
            // Job started or already in progress
            currentJobId = result.job.job_id;
            localStorage.setItem('currentJobId', currentJobId);
            localStorage.setItem('currentUsername', sellerUsername);
            startPolling();
        } else {
            document.getElementById('statusMessage').innerHTML = 
                '<div class="error-message">Unexpected response from server</div>';
            document.getElementById('fetchButton').disabled = false;
            document.getElementById('fetchButton').innerHTML = '<i class="bi bi-search"></i> Search';
        }
    } catch (error) {
        console.error('Error fetching releases:', error);
        document.getElementById('statusMessage').innerHTML = 
            '<div class="error-message">Connection error. Please try again.</div>';
        document.getElementById('fetchButton').disabled = false;
        document.getElementById('fetchButton').innerHTML = '<i class="bi bi-search"></i> Search';
    }
}

// Show refresh option for cached data
function showRefreshOption(sellerUsername) {
    const statusMessage = document.getElementById('statusMessage');
    statusMessage.innerHTML = `
        <div class="alert alert-success">
            Data loaded from cache! 
            <button class="btn btn-sm btn-outline-primary ms-2" onclick="forceRefresh('${sellerUsername}')">
                <i class="bi bi-arrow-clockwise"></i> Refresh
            </button>
            <button class="btn btn-sm btn-outline-danger ms-2" onclick="clearSellerData('${sellerUsername}')">
                <i class="bi bi-trash"></i> Clear Data
            </button>
        </div>
    `;
}

// Force refresh of seller data
async function forceRefresh(sellerUsername) {
    stopPolling();
    
    document.getElementById('progressSection').classList.add('active');
    document.getElementById('progressBar').style.width = '0%';
    document.getElementById('progressBar').textContent = '0%';
    document.getElementById('statusMessage').textContent = 'Refreshing data...';

    try {
        const response = await fetch(`${getApiUrl()}/api/seller/${encodeURIComponent(sellerUsername)}?force_refresh=true`);
        const result = await response.json();

        if (result.status === 'started') {
            currentJobId = result.job.job_id;
            localStorage.setItem('currentJobId', currentJobId);
            localStorage.setItem('currentUsername', sellerUsername);
            startPolling();
        }
    } catch (error) {
        console.error('Error refreshing:', error);
        document.getElementById('statusMessage').innerHTML = 
            '<div class="error-message">Error refreshing data</div>';
    }
}

// Start polling for job status
function startPolling() {
    if (pollInterval) {
        clearInterval(pollInterval);
    }
    
    // Poll immediately, then every 2 seconds
    pollJobStatus();
    pollInterval = setInterval(pollJobStatus, 2000);
}

// Stop polling
function stopPolling() {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
}

// Poll job status
async function pollJobStatus() {
    if (!currentJobId) {
        stopPolling();
        return;
    }

    try {
        const response = await fetch(`${getApiUrl()}/api/job/${currentJobId}`);
        const result = await response.json();

        if (result.error) {
            stopPolling();
            document.getElementById('statusMessage').innerHTML = 
                '<div class="error-message">Job not found</div>';
            localStorage.removeItem('currentJobId');
            localStorage.removeItem('currentUsername');
            document.getElementById('fetchButton').disabled = false;
            document.getElementById('fetchButton').innerHTML = '<i class="bi bi-search"></i> Search';
            return;
        }

        const job = result.job;
        updateProgress(job);

        // Display partial results as they come in
        if (result.data && result.data.releases && result.data.releases.length > 0) {
            displayResults(result.data.releases, job.status !== 'complete');
        }

        if (job.status === 'complete') {
            stopPolling();
            localStorage.removeItem('currentJobId');
            localStorage.removeItem('currentUsername');
            
            if (result.data && result.data.releases) {
                displayResults(result.data.releases, false);
            }
            
            document.getElementById('statusMessage').textContent = 'Complete!';
            document.getElementById('fetchButton').disabled = false;
            document.getElementById('fetchButton').innerHTML = '<i class="bi bi-search"></i> Search';
            
            // Hide progress section after a delay
            setTimeout(() => {
                document.getElementById('progressSection').classList.remove('active');
            }, 3000);
        } else if (job.status === 'error' || job.status === 'cancelled') {
            stopPolling();
            localStorage.removeItem('currentJobId');
            localStorage.removeItem('currentUsername');
            
            const message = job.status === 'cancelled' 
                ? 'Job was cancelled' 
                : `Error: ${job.error_message || 'Unknown error'}`;
            
            document.getElementById('statusMessage').innerHTML = 
                `<div class="alert alert-${job.status === 'cancelled' ? 'warning' : 'danger'}">${message}</div>`;
            document.getElementById('fetchButton').disabled = false;
            document.getElementById('fetchButton').innerHTML = '<i class="bi bi-search"></i> Search';
            
            // Show partial results if any
            if (result.data && result.data.releases && result.data.releases.length > 0) {
                displayResults(result.data.releases, false);
            }
            
            // Hide progress section after a delay
            setTimeout(() => {
                document.getElementById('progressSection').classList.remove('active');
            }, 3000);
        }
    } catch (error) {
        console.error('Error polling job status:', error);
        // Don't stop polling on network errors, just log them
    }
}

// Update progress UI
function updateProgress(job) {
    const progress = job.total > 0 ? Math.round((job.progress / job.total) * 100) : 0;
    
    document.getElementById('progressBar').style.width = `${progress}%`;
    document.getElementById('progressBar').textContent = `${progress}%`;
    
    // Show detailed status with cancel button
    const statusDiv = document.getElementById('statusMessage');
    statusDiv.innerHTML = `
        <div class="d-flex justify-content-between align-items-center">
            <span>${job.current_step || 'Processing...'}</span>
            <button class="btn btn-sm btn-danger" onclick="cancelJob('${job.job_id}')">
                <i class="bi bi-x-circle"></i> Cancel
            </button>
        </div>
    `;
}

// Display results
// Track last data to prevent unnecessary re-renders
let lastDataHash = '';

function displayResults(releases, isProcessing = false) {
    // Create a simple hash of the data to detect changes
    const currentHash = JSON.stringify(releases.map(r => r.id + '-' + r.artist_title));
    const hasNewData = currentHash !== lastDataHash;
    
    if (hasNewData || !isProcessing) {
        lastDataHash = currentHash;
        
        // Store the raw data and compute rarity coefficient
        allData = releases.map(r => ({
            ...r,
            // Rarity is high when want is high and have is low
            demand_coeff: computeRarityCoeff(r.have_count, r.want_count)
        }));
        
        // Populate filter options (only on first load)
        if (!isProcessing) {
            populateFilterOptions(allData);
        }
        
        // Apply current filters and sorting (preserving current page if processing)
        const savePage = isProcessing ? currentPage : 1;
        applyFilters(savePage);
    }
    
    // Show a note if still processing
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
        // Remove processing note if it exists
        const existingNote = document.getElementById('processingNote');
        if (existingNote) {
            existingNote.remove();
        }
        lastDataHash = ''; // Reset for next fetch
    }
}
// Compute rarity coefficient from have and want
function computeRarityCoeff(have, want) {
    const h = typeof have === 'number' ? have : parseFloat(have) || 0;
    const w = typeof want === 'number' ? want : parseFloat(want) || 0;
    // Add-one smoothing to avoid division by zero and keep monotonic behavior
    return (w + 1) / (h + 1);
}


// Populate filter options (genres, styles, years)
function populateFilterOptions(releases) {
    const genreSelect = document.getElementById('genre');
    const styleSelect = document.getElementById('style');
    const artistSelect = document.getElementById('artist');
    const labelSelect = document.getElementById('label');
    
    // Count frequencies for all filter options
    const genreCounts = new Map();
    const styleCounts = new Map();
    const artistCounts = new Map();
    const labelCounts = new Map();
    
    releases.forEach(release => {
        // Count genres
        if (release.genres) {
            try {
                const genres = JSON.parse(release.genres);
                genres.forEach(g => {
                    genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
                });
            } catch (e) {
                if (Array.isArray(release.genres)) {
                    release.genres.forEach(g => {
                        genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
                    });
                }
            }
        }
        
        // Count styles
        if (release.styles) {
            try {
                const styles = JSON.parse(release.styles);
                styles.forEach(s => {
                    styleCounts.set(s, (styleCounts.get(s) || 0) + 1);
                });
            } catch (e) {
                if (Array.isArray(release.styles)) {
                    release.styles.forEach(s => {
                        styleCounts.set(s, (styleCounts.get(s) || 0) + 1);
                    });
                }
            }
        }
        
        // Count artists
        if (release.artist) {
            const artists = release.artist.split(/[,&\/]/).map(a => a.trim()).filter(a => a);
            artists.forEach(a => {
                artistCounts.set(a, (artistCounts.get(a) || 0) + 1);
            });
        }
        
        // Count labels
        if (release.label) {
            const labels = release.label.split(/[,&\/]/).map(l => l.trim()).filter(l => l);
            labels.forEach(l => {
                labelCounts.set(l, (labelCounts.get(l) || 0) + 1);
            });
        }
    });
    
    // Helper function to populate select with sorted options
    function populateSelect(select, counts, currentValue) {
        select.innerHTML = '';
        const allOption = document.createElement('option');
        allOption.value = '';
        allOption.textContent = select.id === 'genre' ? 'All Genres' : 
                              select.id === 'style' ? 'All Styles' :
                              select.id === 'artist' ? 'All Artists' : 'All Labels';
        select.appendChild(allOption);
        
        // Sort by frequency descending, then alphabetically
        Array.from(counts.entries())
            .sort((a, b) => {
                if (b[1] !== a[1]) return b[1] - a[1]; // Frequency desc
                return a[0].localeCompare(b[0]); // Alphabetically
            })
            .forEach(([value, count]) => {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = `${value} (${count})`;
                if (value === currentValue) option.selected = true;
                select.appendChild(option);
            });
    }
    
    // Populate all selects
    populateSelect(genreSelect, genreCounts, genreSelect.value);
    populateSelect(styleSelect, styleCounts, styleSelect.value);
    populateSelect(artistSelect, artistCounts, artistSelect.value);
    populateSelect(labelSelect, labelCounts, labelSelect.value);
}

// Apply filters
function applyFilters(preservePage = null) {
    const selectedGenre = document.getElementById('genre').value;
    const selectedStyle = document.getElementById('style').value;
    const selectedArtist = document.getElementById('artist').value;
    const selectedLabel = document.getElementById('label').value;
    const yearRange = document.getElementById('year_range').value;
    const ratingRange = document.getElementById('rating_range').value;
    const ratingCountRange = document.getElementById('rating_count_range').value;
    const priceRange = document.getElementById('price_range') ? document.getElementById('price_range').value : '';
    
    // Parse ranges
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
    
    // Filter data
    filteredData = allData.filter(release => {
        // Genre filter
        if (selectedGenre) {
            let genres = [];
            if (release.genres) {
                try {
                    genres = JSON.parse(release.genres);
                } catch (e) {
                    if (Array.isArray(release.genres)) genres = release.genres;
                }
            }
            if (!genres.includes(selectedGenre)) return false;
        }
        
        // Style filter
        if (selectedStyle) {
            let styles = [];
            if (release.styles) {
                try {
                    styles = JSON.parse(release.styles);
                } catch (e) {
                    if (Array.isArray(release.styles)) styles = release.styles;
                }
            }
            if (!styles.includes(selectedStyle)) return false;
        }
        
        // Artist filter
        if (selectedArtist) {
            if (!release.artist) return false;
            const artists = release.artist.split(/[,&\/]/).map(a => a.trim());
            if (!artists.includes(selectedArtist)) return false;
        }
        
        // Label filter
        if (selectedLabel) {
            if (!release.label) return false;
            const labels = release.label.split(/[,&\/]/).map(l => l.trim());
            if (!labels.includes(selectedLabel)) return false;
        }
        
        // Year filter
        if (release.year && (release.year < minYear || release.year > maxYear)) {
            return false;
        }
        
        // Rating filter
        if (release.avg_rating < minRating || release.avg_rating > maxRating) {
            return false;
        }
        
        // Rating count filter
        if (release.num_ratings < minRatingCount || release.num_ratings > maxRatingCount) {
            return false;
        }
        
        // Price filter
        const priceVal = typeof release.price === 'number' ? release.price : parseFloat(release.price) || 0;
        if (priceVal < minPrice || priceVal > maxPrice) {
            return false;
        }
        
        return true;
    });
    
    // Apply sorting
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

// Sort data based on current sort settings
function sortData() {
    if (!currentSort.column) return;
    
    filteredData.sort((a, b) => {
        let aVal = a[currentSort.column];
        let bVal = b[currentSort.column];
        
        // Handle null/undefined values
        if (aVal === null || aVal === undefined) aVal = '';
        if (bVal === null || bVal === undefined) bVal = '';
        
        // Numeric comparison
        if (typeof aVal === 'number' && typeof bVal === 'number') {
            return currentSort.direction === 'asc' ? aVal - bVal : bVal - aVal;
        }
        
        // String comparison
        aVal = String(aVal).toLowerCase();
        bVal = String(bVal).toLowerCase();
        
        if (currentSort.direction === 'asc') {
            return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
        } else {
            return bVal < aVal ? -1 : bVal > aVal ? 1 : 0;
        }
    });
}

// Handle column sort click
function sortByColumn(column) {
    if (currentSort.column === column) {
        // Toggle direction
        currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
        currentSort.column = column;
        currentSort.direction = 'desc';
    }
    
    applyFilters(currentPage); // Preserve current page
    updateSortIndicators();
}

// Clear seller data and reset UI
async function clearSellerData(usernameFromButton) {
    try {
        const sellerInput = document.getElementById('sellerInput');
        const username = (usernameFromButton || sellerInput.value || '').trim();
        if (!username) {
            alert('Please enter a seller username');
            return;
        }
        
        if (!confirm(`Clear all cached data for ${username}?`)) return;
        
        // Cancel polling and clear local state
        stopPolling();
        localStorage.removeItem('currentJobId');
        localStorage.removeItem('currentUsername');
        
        // Call backend to clear
        const resp = await fetch(`${getApiUrl()}/api/seller/${encodeURIComponent(username)}/clear`, { method: 'POST' });
        if (!resp.ok) throw new Error('Failed to clear on server');
        
        // Reset UI
        allData = [];
        filteredData = [];
        totalRecords = 0;
        currentPage = 1;
        totalPages = 1;
        currentJobId = null;
        
        // Reset table body
        const tbody = document.getElementById('releases-table-body');
        if (tbody) {
            // Show "No releases found" if a search has been performed, otherwise show initial message
            if (hasSearched) {
                tbody.innerHTML = '<tr><td class="no-results" colspan="11"><p>No releases found</p></td></tr>';
            } else {
                tbody.innerHTML = '<tr><td class="no-results" colspan="11"><p>Enter a Discogs seller username and click Search to get started</p></td></tr>';
            }
        }
        
        // Reset pagination
        const pagination = document.getElementById('pagination');
        if (pagination) {
            pagination.innerHTML = '';
            pagination.style.display = 'none';
        }
        
        // Hide progress
        document.getElementById('progressSection').classList.remove('active');
        document.getElementById('statusMessage').textContent = '';
        
        // Enable search button
        const btn = document.getElementById('fetchButton');
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="bi bi-search"></i> Search';
        }
        
        alert('Data cleared. You can search again to fetch fresh data.');
    } catch (e) {
        console.error('Failed to clear seller data:', e);
        alert('Failed to clear data.');
    }
}

// Render table
function renderTable() {
    const tbody = document.getElementById('releases-table-body');
    if (!tbody) {
        console.error('Could not find tbody element');
        return;
    }
    
    // Set up table headers if not already done
    setupTableHeaders();
    updateSortIndicators();
    
    // Track existing rows to preserve iframes
    const existingRows = new Map();
    tbody.querySelectorAll('tr[data-release-id]').forEach((row) => {
        const rid = row.getAttribute('data-release-id');
        if (rid) {
            existingRows.set(rid, row);
        }
    });
    
    if (filteredData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="11" class="text-center">No releases found</td></tr>';
        return;
    }
    
    const start = (currentPage - 1) * pageSize;
    const end = Math.min(start + pageSize, filteredData.length);
    const pageData = filteredData.slice(start, end);
    
    // Clear only rows that aren't in current page
    const currentPageIds = new Set(pageData.map(r => String(r.id)));
    existingRows.forEach((row, rid) => {
        if (!currentPageIds.has(rid)) {
            row.remove();
        }
    });
    
    pageData.forEach((release, index) => {
        const releaseId = String(release.id);
        let row = existingRows.get(releaseId);
        
        if (!row) {
            // Create new row
            row = document.createElement('tr');
            row.setAttribute('data-release-id', releaseId);
            renderRow(row, release);
            tbody.appendChild(row);
        }
        // If row exists, leave it untouched to preserve iframe state
    });
    
    document.getElementById('resultsSection').style.display = 'block';
}

// Render a single table row
function renderRow(row, release) {
    // Parse genres and styles
    let genres = [];
    let styles = [];
    try {
        if (release.genres) genres = JSON.parse(release.genres);
        if (release.styles) styles = JSON.parse(release.styles);
    } catch (e) {
        if (Array.isArray(release.genres)) genres = release.genres;
        if (Array.isArray(release.styles)) styles = release.styles;
    }
    
    const genreText = genres.length > 0 ? genres.join(', ') : '-';
    const styleText = styles.length > 0 ? styles.join(', ') : '-';
    
    // Video links from Discogs + YouTube preview cell with carousel
    let videoCell = '';
    let videoLinks = [];
    
    // Parse video URLs from Discogs
    if (release.video_urls) {
        try {
            videoLinks = JSON.parse(release.video_urls);
        } catch (e) {
            if (Array.isArray(release.video_urls)) {
                videoLinks = release.video_urls;
            }
        }
    }
    
    // Extract YouTube ID helper
    const extractYouTubeID = (url) => {
        const regex = /(?:youtube\.com\/.*v=|youtu\.be\/)([^"&?/\s]{11})/;
        const match = url.match(regex);
        return match ? match[1] : null;
    };
    
    // Build video cell content with carousel
    if (videoLinks && videoLinks.length > 0) {
        const firstVideo = videoLinks[0];
        const firstVideoId = extractYouTubeID(firstVideo.url);
        
        if (firstVideoId) {
            // Create carousel for embedded video
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
            
            // Add navigation if multiple videos (use data attributes for event delegation)
            if (videoLinks.length > 1) {
                videoCell += `
                    <div class="video-nav d-flex justify-content-between align-items-center mt-1">
                        <button class="btn btn-sm btn-outline-secondary video-nav-btn" data-release-id="${release.id}" data-direction="-1" data-videos='${JSON.stringify(videoLinks)}'>
                            <i class="bi bi-chevron-left"></i>
                        </button>
                        <span class="video-counter" id="counter-${release.id}">1 / ${videoLinks.length}</span>
                        <button class="btn btn-sm btn-outline-secondary video-nav-btn" data-release-id="${release.id}" data-direction="1" data-videos='${JSON.stringify(videoLinks)}'>
                            <i class="bi bi-chevron-right"></i>
                        </button>
                    </div>
                `;
            }
            videoCell += '</div>';
        } else {
            // Fallback to links
            videoCell = '<div class="video-links">';
            videoLinks.forEach((video, idx) => {
                if (idx < 3) {
                    videoCell += `<a href="${escapeHtml(video.url)}" target="_blank" class="btn btn-sm btn-outline-primary mb-1" style="display: block; font-size: 0.75rem;">
                        <i class="bi bi-play-circle"></i> ${escapeHtml(video.title || 'Video ' + (idx + 1))}
                    </a>`;
                }
            });
            videoCell += '</div>';
        }
    } else if (release.youtube_video_id) {
        videoCell = `
            <div class="youtube-preview">
                <button class="btn btn-sm btn-danger" onclick="playYouTubePreview('${release.youtube_video_id}', ${release.id})">
                    <i class="bi bi-youtube"></i> Preview
                </button>
                <div id="youtube-player-${release.id}" class="youtube-player-container" style="display: none; margin-top: 5px;">
                    <div id="player-${release.id}" style="width: 200px; height: 150px;"></div>
                </div>
            </div>
        `;
    } else {
        videoCell = `
            <a href="https://www.youtube.com/results?search_query=${encodeURIComponent((release.artist || '') + ' ' + (release.title || release.artist_title || ''))}" 
               target="_blank" class="btn btn-sm btn-outline-secondary">
                <i class="bi bi-search"></i> Search
            </a>
        `;
    }
    
    // Combine genre and style in one cell
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
    
    row.innerHTML = `
        <td><a href="${release.url}" target="_blank" class="release-link">${escapeHtml(release.title || release.artist_title)}</a></td>
        <td>${escapeHtml(release.label || '-')}</td>
        <td class="text-center">${release.year || '-'}</td>
    `;
    row.appendChild(genreStyleCell);
    // Rating cell: stars + average + count
    const ratingStars = release.avg_rating ? generateStars(release.avg_rating) : '<div class="text-muted">No rating</div>';
    const ratingText = release.avg_rating ? `${parseFloat(release.avg_rating).toFixed(2)}${release.num_ratings ? ` (${release.num_ratings})` : ''}` : '';
    row.innerHTML += `
        <td class="text-center">${ratingStars} ${ratingText}</td>
        <td class="text-center">${release.demand_coeff ? parseFloat(release.demand_coeff).toFixed(2) : '-'}</td>
        <td class="text-center">${release.num_ratings || '0'}</td>
        <td class="text-center">${release.have_count || '0'}</td>
        <td class="text-center">${release.want_count || '0'}</td>
        <td class="text-center">${release.price ? '$' + release.price.toFixed(2) : '-'}</td>
        <td class="text-center">${videoCell}</td>
    `;
}

// Setup table headers
function setupTableHeaders() {
    const thead = document.getElementById('table-header');
    if (thead.querySelector('tr')) {
        return; // Already set up
    }
    
    const columns = [
        { key: 'title', label: 'Title' },
        { key: 'label', label: 'Label' },
        { key: 'year', label: 'Year' },
        { key: null, label: 'Genre / Style', nosort: true },
        // Sort rating by bayesian score, not raw average
        { key: 'bayesian_score', label: 'Rating' },
        { key: 'demand_coeff', label: 'Rarity' },
        { key: 'num_ratings', label: '# Ratings' },
        { key: 'have_count', label: 'Have' },
        { key: 'want_count', label: 'Want' },
        { key: 'price', label: 'Price' },
        { key: null, label: 'Videos', nosort: true }
    ];
    
    const headerRow = document.createElement('tr');
    columns.forEach(col => {
        const th = document.createElement('th');
        th.setAttribute('data-column-name', col.label);
        
        if (col.key && !col.nosort) {
            th.setAttribute('data-sort-key', col.key);
            th.style.cursor = 'pointer';
            th.addEventListener('click', () => sortByColumn(col.key));
            th.innerHTML = col.label;
            
            // Add resizer
            const resizer = document.createElement('div');
            resizer.className = 'resizer';
            th.appendChild(resizer);
        } else {
            th.textContent = col.label;
        }
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
}

// Update sort indicators in headers (matching repeat98.github.io style)
function updateSortIndicators() {
    const thead = document.getElementById('table-header');
    if (!thead) return;
    
    const ths = thead.querySelectorAll('th[data-sort-key]');
    ths.forEach(th => {
        const sortKey = th.getAttribute('data-sort-key');
        const colName = th.getAttribute('data-column-name');
        
        // Reset innerHTML to just the column name
        th.innerHTML = colName;
        
        // Add sort indicator if this column is currently sorted
        if (sortKey && currentSort.column === sortKey) {
            const icon = currentSort.direction === 'asc' 
                ? '<i class="bi bi-arrow-up sort-indicator"></i>'
                : '<i class="bi bi-arrow-down sort-indicator"></i>';
            th.innerHTML += icon;
        }
        
        // Add resizer back
        const resizer = document.createElement('div');
        resizer.className = 'resizer';
        th.appendChild(resizer);
    });
}

// Play YouTube preview
function playYouTubePreview(videoId, releaseId) {
    const playerContainer = document.getElementById(`youtube-player-${releaseId}`);
    const playerId = `player-${releaseId}`;
    
    if (playerContainer.style.display === 'none') {
        playerContainer.style.display = 'block';
        
        // Create player if it doesn't exist
        if (!youtubePlayerInstances[releaseId]) {
            if (typeof YT !== 'undefined' && YT.Player) {
                youtubePlayerInstances[releaseId] = new YT.Player(playerId, {
                    height: '150',
                    width: '200',
                    videoId: videoId,
                    playerVars: {
                        'autoplay': 1,
                        'modestbranding': 1,
                        'rel': 0
                    }
                });
            }
        }
    } else {
        playerContainer.style.display = 'none';
        if (youtubePlayerInstances[releaseId]) {
            youtubePlayerInstances[releaseId].stopVideo();
        }
    }
}

// Render pagination
function renderPagination() {
    const pagination = document.getElementById('pagination');
    pagination.innerHTML = '';
    
    if (totalPages <= 1) {
        pagination.style.display = 'none';
        return;
    }
    
    pagination.style.display = 'flex';
    
    // Previous button
    const prevLi = document.createElement('li');
    prevLi.className = `page-item ${currentPage === 1 ? 'disabled' : ''}`;
    prevLi.innerHTML = `<a class="page-link" href="#" onclick="changePage(${currentPage - 1}); return false;">Previous</a>`;
    pagination.appendChild(prevLi);
    
    // Page numbers
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
    
    // Next button
    const nextLi = document.createElement('li');
    nextLi.className = `page-item ${currentPage === totalPages ? 'disabled' : ''}`;
    nextLi.innerHTML = `<a class="page-link" href="#" onclick="changePage(${currentPage + 1}); return false;">Next</a>`;
    pagination.appendChild(nextLi);
}

// Change page
function changePage(page) {
    if (page < 1 || page > totalPages) return;
    currentPage = page;
    renderTable();
    renderPagination();
}

// Cancel job
async function cancelJob(jobId) {
    if (!confirm('Are you sure you want to cancel this job?')) {
        return;
    }
    
    try {
        const response = await fetch(`${getApiUrl()}/api/job/${jobId}/cancel`, {
            method: 'POST'
        });
        
        if (response.ok) {
            stopPolling();
            localStorage.removeItem('currentJobId');
            localStorage.removeItem('currentUsername');
            
            document.getElementById('statusMessage').innerHTML = 
                '<div class="alert alert-warning">Job cancelled</div>';
            document.getElementById('fetchButton').disabled = false;
            document.getElementById('fetchButton').innerHTML = '<i class="bi bi-search"></i> Search';
            
            // Hide progress section after a delay
            setTimeout(() => {
                document.getElementById('progressSection').classList.remove('active');
            }, 2000);
        }
    } catch (error) {
        console.error('Error cancelling job:', error);
        alert('Failed to cancel job');
    }
}

// Escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Initialize YouTube players
function initializeYouTubePlayers() {
    // YouTube API is now ready, players will be created on demand
    console.log('YouTube API ready');
}

// Render star icons from average rating (0..5)
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

// Note: Service worker warnings from YouTube (sw.js) are harmless and can be ignored
// These occur because YouTube uses navigation preload in their service worker
// and are unrelated to our application's functionality

// Video carousel navigation
let currentVideoIndex = {};

// Event delegation for video carousel buttons (works for dynamically added elements)
document.addEventListener('click', function(e) {
    if (e.target.closest('.video-nav-btn')) {
        const btn = e.target.closest('.video-nav-btn');
        const releaseId = parseInt(btn.getAttribute('data-release-id'));
        const direction = parseInt(btn.getAttribute('data-direction'));
        const videosJson = btn.getAttribute('data-videos');
        
        if (releaseId && direction && videosJson) {
            try {
                const videos = JSON.parse(videosJson);
                changeVideo(releaseId, direction, videos);
            } catch (err) {
                console.error('Error parsing videos JSON:', err);
            }
        }
    }
});

function changeVideo(releaseId, direction, videos) {
    // Initialize or get current index
    if (!currentVideoIndex[releaseId]) {
        currentVideoIndex[releaseId] = 0;
    }
    
    // Update index
    currentVideoIndex[releaseId] += direction;
    if (currentVideoIndex[releaseId] < 0) {
        currentVideoIndex[releaseId] = videos.length - 1;
    } else if (currentVideoIndex[releaseId] >= videos.length) {
        currentVideoIndex[releaseId] = 0;
    }
    
    const currentIndex = currentVideoIndex[releaseId];
    const video = videos[currentIndex];
    
    // Extract YouTube ID
    const regex = /(?:youtube\.com\/.*v=|youtu\.be\/)([^"&?/\s]{11})/;
    const match = video.url.match(regex);
    const videoId = match ? match[1] : null;
    
    if (videoId) {
        // Update iframe src
        const iframe = document.getElementById(`youtube-player-${releaseId}`);
        if (iframe) {
            iframe.src = `https://www.youtube.com/embed/${videoId}?enablejsapi=1&rel=0&modestbranding=1`;
        }
        
        // Update counter
        const counter = document.getElementById(`counter-${releaseId}`);
        if (counter) {
            counter.textContent = `${currentIndex + 1} / ${videos.length}`;
        }
    }
}
