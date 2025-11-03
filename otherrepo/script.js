// --- Existing Code ---
const supabaseUrl = "https://oghdrmtorpeqaewttckr.supabase.co";
const supabaseKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9naGRybXRvcnBlcWFld3R0Y2tyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDExNjc4OTksImV4cCI6MjA1Njc0Mzg5OX0.HW5aD19Hy__kpOLp5JHi8HXLzl7D6_Tu4UNyB3mNAHs";
const supabaseClient = supabase.createClient(supabaseUrl, supabaseKey);

// Global pagination and sorting config for Search and Shuffle
let filteredData = [];
let totalRecords = 0;
let currentPage = 1;
const pageSize = 10;
let totalPages = 1;

// Global active tab state: "search", "shuffle", "bookmark", "artists", "labels", or "entity" (drill-down)
let activeTab = "search";

// Global data for artists and labels
let artistsData = [];
let labelsData = [];

// When drilling down: list releases for a specific artist/label
let entityDetail = null; // { type: 'artist' | 'label', name: string }


// Default: Sort by title ascending
let sortConfig = { key: "title", order: "asc" };

let youtubeApiReady = false;


// ------------------ Bookmark Data ------------------
function getBookmarkedReleases() {
  return JSON.parse(localStorage.getItem("bookmarkedReleases") || "[]");
}

function saveBookmarkedReleases(bookmarks) {
  localStorage.setItem("bookmarkedReleases", JSON.stringify(bookmarks));
}

function isBookmarked(id) {
  const bookmarks = getBookmarkedReleases();
  return bookmarks.some(release => release.id === id);
}

function toggleBookmark(release) {
  let bookmarks = getBookmarkedReleases();
  let action;
  if (isBookmarked(release.id)) {
    bookmarks = bookmarks.filter(r => r.id !== release.id);
    action = "removed";
  } else {
    release.bookmarkedAt = new Date().toISOString();
    bookmarks.push(release);
    action = "added";
  }
  saveBookmarkedReleases(bookmarks);
  gtag("event", "bookmark_toggle", {
    action: action,
    release_id: release.id,
    title: release.title,
  });
  const row = document.querySelector(`tr[data-id="${release.id}"]`);
  if (row) {
    const bookmarkIcon = row.querySelector(".bookmark-star");
    if (bookmarkIcon) {
      if (isBookmarked(release.id)) {
        bookmarkIcon.classList.remove("bi-bookmark");
        bookmarkIcon.classList.add("bi-bookmark-fill", "bookmarked");
      } else {
        bookmarkIcon.classList.remove("bi-bookmark-fill", "bookmarked");
        bookmarkIcon.classList.add("bi-bookmark");
      }
    }
  }
  if (activeTab === "bookmark") {
    loadBookmarks(currentPage);
  }
}

// ------------------ Helper Functions ------------------
function parseYearRange() {
  const yr = document.getElementById("year_range").value.trim();
  if (!yr) return { min: -Infinity, max: Infinity };
  const match = yr.match(/^(\d{4})\s*-\s*(\d{4})$/);
  if (match) {
    return { min: parseInt(match[1], 10), max: parseInt(match[2], 10) };
  } else {
    const single = parseInt(yr, 10);
    return Number.isInteger(single)
      ? { min: single, max: single }
      : { min: -Infinity, max: Infinity };
  }
}

function parseRangeInput(rangeStr) {
  if (!rangeStr) return { min: -Infinity, max: Infinity };
  const match = rangeStr.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
  if (match) {
    return { min: parseFloat(match[1]), max: parseFloat(match[2]) };
  } else {
    const single = parseFloat(rangeStr);
    return !isNaN(single)
      ? { min: single, max: single }
      : { min: -Infinity, max: Infinity };
  }
}

// ------------------ Query Functions ------------------
async function fetchReleases({ page = 1, retryCount = 0 } = {}) {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 1000; // 1 second

  try {
    const selectedGenre = document.getElementById("genre").value;
    const selectedStyle = document.getElementById("style").value;
    const { min: yearMin, max: yearMax } = parseYearRange();
    const ratingRange = parseRangeInput(document.getElementById("rating_range").value.trim());
    const ratingCountRange = parseRangeInput(document.getElementById("rating_count_range").value.trim());
    const priceRange = parseRangeInput(document.getElementById("price_range").value.trim());
    let query = supabaseClient.from("releases").select("*", { count: "planned" });
    const searchQuery = document.getElementById("searchInput").value.trim();
    
    // Show loading state
    const tbody = document.getElementById("releases-table-body");
    tbody.innerHTML = `<tr><td class="no-results" colspan="12">
      <div class="spinner-border text-primary" role="status">
        <span class="visually-hidden">Loading...</span>
      </div>
      <p>Searching${retryCount > 0 ? ` (Attempt ${retryCount + 1}/${MAX_RETRIES})` : ''}...</p>
    </td></tr>`;

    if (searchQuery) {
      query = query.ilike("title", `%${searchQuery}%`);
    }
    if (selectedGenre) {
      query = query.ilike("genre", `%${selectedGenre}%`);
    }
    if (selectedStyle) {
      query = query.ilike("style", `%${selectedStyle}%`);
    }
    if (yearMin !== -Infinity) query = query.gte("year", yearMin);
    if (yearMax !== Infinity) query = query.lte("year", yearMax);
    if (ratingRange.min !== -Infinity) query = query.gte("average_rating", ratingRange.min);
    if (ratingRange.max !== Infinity) query = query.lte("average_rating", ratingRange.max);
    if (ratingCountRange.min !== -Infinity) query = query.gte("rating_count", ratingCountRange.min);
    if (ratingCountRange.max !== Infinity) query = query.lte("rating_count", ratingCountRange.max);
    if (priceRange.min !== -Infinity) query = query.gte("lowest_price", priceRange.min);
    if (priceRange.max !== Infinity) query = query.lte("lowest_price", priceRange.max);
    // Validate sort key against releases table columns
    const validReleaseSortKeys = new Set([
      "title",
      "label",
      "year",
      "rating_coeff",
      "demand_coeff",
      "gem_value",
      "have",
      "want",
      "lowest_price",
      "average_rating",
      "rating_count"
    ]);
    const sortKeyToUse = validReleaseSortKeys.has(sortConfig.key) ? sortConfig.key : "title";
    query = query.order(sortKeyToUse, { ascending: sortConfig.order === "asc" });
    const start = (page - 1) * pageSize;
    const end = start + pageSize - 1;
    query = query.range(start, end);
    
    const { data, count, error } = await query;
    
    if (error) {
      console.error(`Error fetching releases data (attempt ${retryCount + 1}/${MAX_RETRIES}):`, error);
      
      // If we haven't exceeded max retries, try again after a delay
      if (retryCount < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        return fetchReleases({ page, retryCount: retryCount + 1 });
      }
      
      // If we've exceeded retries, show error message
      tbody.innerHTML = `<tr><td class="no-results" colspan="12">
        <i class="bi bi-exclamation-triangle-fill"></i>
        <p>Failed to load results after ${MAX_RETRIES} attempts. Please try again.</p>
      </td></tr>`;
      return { data: [], count: 0 };
    }

    // If we got data but it's empty and we haven't exceeded retries, try again
    if ((!data || data.length === 0) && retryCount < MAX_RETRIES) {
      console.log(`No results found (attempt ${retryCount + 1}/${MAX_RETRIES}), retrying...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return fetchReleases({ page, retryCount: retryCount + 1 });
    }

    return { data, count };
  } catch (error) {
    console.error(`Error in fetchReleases (attempt ${retryCount + 1}/${MAX_RETRIES}):`, error);
    
    // If we haven't exceeded max retries, try again after a delay
    if (retryCount < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return fetchReleases({ page, retryCount: retryCount + 1 });
    }
    
    // If we've exceeded retries, show error message
    const tbody = document.getElementById("releases-table-body");
    tbody.innerHTML = `<tr><td class="no-results" colspan="12">
      <i class="bi bi-exclamation-triangle-fill"></i>
      <p>Failed to load results after ${MAX_RETRIES} attempts. Please try again.</p>
    </td></tr>`;
    return { data: [], count: 0 };
  }
}

async function loadData(page = 1) {
  try {
    const { data, count } = await fetchReleases({ page });
    filteredData = data;
    totalRecords = count || 0;
    totalPages = Math.ceil(totalRecords / pageSize) || 1;
    currentPage = page;
    renderTable();
    renderPagination();
    document.getElementById("pagination").style.display = "block";
  } catch (error) {
    console.error("Error in loadData:", error);
    const tbody = document.getElementById("releases-table-body");
    tbody.innerHTML = `<tr><td class="no-results" colspan="12">
      <i class="bi bi-exclamation-triangle-fill"></i>
      <p>An error occurred while loading results. Please try again.</p>
    </td></tr>`;
  }
}

async function fetchShuffleReleases({ retryCount = 0 } = {}) {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 1000; // 1 second

  try {
    // Apply filtering logic (same as in fetchReleases)
    const selectedGenre = document.getElementById("genre").value;
    const selectedStyle = document.getElementById("style").value;
    const { min: yearMin, max: yearMax } = parseYearRange();
    const ratingRange = parseRangeInput(document.getElementById("rating_range").value.trim());
    const ratingCountRange = parseRangeInput(document.getElementById("rating_count_range").value.trim());
    const priceRange = parseRangeInput(document.getElementById("price_range").value.trim());
    
    let query = supabaseClient.from("releases").select("id,title,label,year,genre,style,average_rating,rating_count,demand_coeff,gem_value,have,want,lowest_price,youtube_links,link,rating_coeff", { count: "planned" });
    const searchQuery = document.getElementById("searchInput").value.trim();
    if (searchQuery) {
      query = query.ilike("title", `%${searchQuery}%`);
    }
    if (selectedGenre) {
      query = query.ilike("genre", `%${selectedGenre}%`);
    }
    if (selectedStyle) {
      query = query.ilike("style", `%${selectedStyle}%`);
    }
    if (yearMin !== -Infinity) query = query.gte("year", yearMin);
    if (yearMax !== Infinity) query = query.lte("year", yearMax);
    if (ratingRange.min !== -Infinity) query = query.gte("average_rating", ratingRange.min);
    if (ratingRange.max !== Infinity) query = query.lte("average_rating", ratingRange.max);
    if (ratingCountRange.min !== -Infinity) query = query.gte("rating_count", ratingCountRange.min);
    if (ratingCountRange.max !== Infinity) query = query.lte("rating_count", ratingCountRange.max);
    if (priceRange.min !== -Infinity) query = query.gte("lowest_price", priceRange.min);
    if (priceRange.max !== Infinity) query = query.lte("lowest_price", priceRange.max);

    // Get the filtered count and data
    const { data: allData, count, error } = await query;
    if (error) {
      console.error(`Error fetching shuffle data (attempt ${retryCount + 1}/${MAX_RETRIES}):`, error);
      
      // If we haven't exceeded max retries, try again after a delay
      if (retryCount < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        return fetchShuffleReleases({ retryCount: retryCount + 1 });
      }
      
      return { data: [], count: 0 };
    }
    
    const shuffleSize = 10; // Increased from 5 to 10
    if (count > shuffleSize) {
      // Optimize: Instead of rebuilding the query, use the existing query with range
      const randomOffset = Math.floor(Math.random() * (count - shuffleSize + 1));
      const { data, error: err } = await query.range(randomOffset, randomOffset + shuffleSize - 1);
      
      if (err) {
        console.error(`Error fetching shuffle data with range (attempt ${retryCount + 1}/${MAX_RETRIES}):`, err);
        
        // If we haven't exceeded max retries, try again after a delay
        if (retryCount < MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
          return fetchShuffleReleases({ retryCount: retryCount + 1 });
        }
        
        return { data: [], count: 0 };
      }
      
      // If we got data but it's empty and we haven't exceeded retries, try again
      if ((!data || data.length === 0) && retryCount < MAX_RETRIES) {
        console.log(`No shuffle results found (attempt ${retryCount + 1}/${MAX_RETRIES}), retrying...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        return fetchShuffleReleases({ retryCount: retryCount + 1 });
      }
      
      return { data, count: shuffleSize };
    } else {
      // If we got data but it's empty and we haven't exceeded retries, try again
      if ((!allData || allData.length === 0) && retryCount < MAX_RETRIES) {
        console.log(`No shuffle results found (attempt ${retryCount + 1}/${MAX_RETRIES}), retrying...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        return fetchShuffleReleases({ retryCount: retryCount + 1 });
      }
      
      return { data: allData, count };
    }
  } catch (error) {
    console.error(`Error in fetchShuffleReleases (attempt ${retryCount + 1}/${MAX_RETRIES}):`, error);
    
    // If we haven't exceeded max retries, try again after a delay
    if (retryCount < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return fetchShuffleReleases({ retryCount: retryCount + 1 });
    }
    
    return { data: [], count: 0 };
  }
}


async function loadShuffleData() {
  try {
    // Show loading state
    const tbody = document.getElementById("releases-table-body");
    tbody.innerHTML = `<tr><td class="no-results" colspan="12">
      <div class="spinner-border text-primary" role="status">
        <span class="visually-hidden">Loading...</span>
      </div>
      <p>Loading shuffle results...</p>
    </td></tr>`;

    const { data, count } = await fetchShuffleReleases();
    filteredData = data;
    totalRecords = count;
    currentPage = 1;
    renderTable();
    document.getElementById("pagination").style.display = "none";
  } catch (error) {
    console.error("Error in loadShuffleData:", error);
    const tbody = document.getElementById("releases-table-body");
    tbody.innerHTML = `<tr><td class="no-results" colspan="12">
      <i class="bi bi-exclamation-triangle-fill"></i>
      <p>An error occurred while loading shuffle results. Please try again.</p>
    </td></tr>`;
  }
}

// ------------------ Load Artists Data ------------------
function extractPossibleArtistsFromTitle(title) {
  if (!title) return [];
  const dashSplit = title.split(" - ");
  const maybeArtist = dashSplit.length > 1 ? dashSplit[0] : title;
  return maybeArtist
    .split(/,|&|\+|\//)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function fetchArtistsData() {
  try {
    const { data, error } = await supabaseClient
      .from("releases")
      .select("title, artist, average_rating, rating_count", { count: "planned" });
    
    if (error) {
      console.error("Error fetching artists data:", error);
      return [];
    }

    // Aggregate + Bayesian
    const artistsMap = new Map();
    let globalWeightedSum = 0;
    let globalRatingsCount = 0;
    
    data.forEach((release) => {
      const names = (release.artist && release.artist.trim())
        ? release.artist.split(/[,&\/]/).map((a) => a.trim()).filter(Boolean)
        : extractPossibleArtistsFromTitle(release.title);
      if (!names || names.length === 0) return;

      const avg = release.average_rating != null ? parseFloat(release.average_rating) : null;
      const cnt = release.rating_count != null ? parseFloat(release.rating_count) : 0;
      if (avg !== null && cnt > 0) {
        globalWeightedSum += avg * cnt;
        globalRatingsCount += cnt;
      }

      names.forEach((artist) => {
        if (!artistsMap.has(artist)) {
          artistsMap.set(artist, {
            name: artist,
            releases: 0,
            ratingWeightedSum: 0,
            ratingCountSum: 0,
            averageRating: 0,
            bayes_rating: 0,
          });
        }
        const a = artistsMap.get(artist);
        a.releases += 1;
        if (avg !== null && cnt > 0) {
          a.ratingWeightedSum += avg * cnt;
          a.ratingCountSum += cnt;
        }
      });
    });

    const C = globalRatingsCount > 0 ? globalWeightedSum / globalRatingsCount : 0;
    const m = 50;
    const artistsArray = Array.from(artistsMap.values()).map((a) => {
      const v = a.ratingCountSum;
      const R = v > 0 ? a.ratingWeightedSum / v : 0;
      a.averageRating = R;
      a.bayes_rating = v > 0 ? (v / (v + m)) * R + (m / (v + m)) * C : 0;
      return a;
    });

    return artistsArray;
  } catch (error) {
    console.error("Error in fetchArtistsData:", error);
    return [];
  }
}

async function loadArtistsData() {
  try {
    const tbody = document.getElementById("releases-table-body");
    tbody.innerHTML = `<tr><td class="no-results" colspan="3">
      <div class="spinner-border text-primary" role="status">
        <span class="visually-hidden">Loading...</span>
      </div>
      <p>Loading artists...</p>
    </td></tr>`;

    artistsData = await fetchArtistsData();
    totalRecords = artistsData.length;
    totalPages = Math.ceil(totalRecords / pageSize) || 1;
    currentPage = 1;
    
    // Set default sort for artists to name ascending if no sort is set
    if (!sortConfig.key || !["name", "releases", "averageRating"].includes(sortConfig.key)) {
      sortConfig.key = "name";
      sortConfig.order = "asc";
    }
    
    // Apply sorting
    sortArtistsData();
    
    // Paginate
    filteredData = artistsData.slice((currentPage - 1) * pageSize, currentPage * pageSize);
    
    renderArtistsTable();
    renderPagination();
    document.getElementById("pagination").style.display = "block";
  } catch (error) {
    console.error("Error in loadArtistsData:", error);
    const tbody = document.getElementById("releases-table-body");
    tbody.innerHTML = `<tr><td class="no-results" colspan="3">
      <i class="bi bi-exclamation-triangle-fill"></i>
      <p>An error occurred while loading artists. Please try again.</p>
    </td></tr>`;
  }
}

function sortArtistsData() {
  artistsData.sort((a, b) => {
    let aVal = a[sortConfig.key];
    let bVal = b[sortConfig.key];
    
    if (sortConfig.key === "name") {
      aVal = aVal ? aVal.toLowerCase() : "";
      bVal = bVal ? bVal.toLowerCase() : "";
    } else {
      aVal = parseFloat(aVal) || 0;
      bVal = parseFloat(bVal) || 0;
    }
    
    if (aVal < bVal) return sortConfig.order === "asc" ? -1 : 1;
    if (aVal > bVal) return sortConfig.order === "asc" ? 1 : -1;
    return 0;
  });
}

// ------------------ Load Labels Data ------------------
async function fetchLabelsData() {
  try {
    const { data, error } = await supabaseClient
      .from("releases")
      .select("label, average_rating, rating_count", { count: "planned" })
      .not("label", "is", null);
    
    if (error) {
      console.error("Error fetching labels data:", error);
      return [];
    }

    // Aggregate labels data
    const labelsMap = new Map();
    let globalWeightedSum = 0;
    let globalRatingsCount = 0;
    
    data.forEach(release => {
      if (!release.label || release.label.trim() === "") return;
      
      const labels = release.label.split(/[,&\/]/).map(l => l.trim()).filter(l => l);
      
      labels.forEach(label => {
        if (!labelsMap.has(label)) {
          labelsMap.set(label, {
            name: label,
            releases: 0,
            ratingWeightedSum: 0,
            ratingCountSum: 0,
            averageRating: 0,
            bayes_rating: 0
          });
        }
        
        const labelData = labelsMap.get(label);
        labelData.releases += 1;
        const avg = release.average_rating != null ? parseFloat(release.average_rating) : null;
        const cnt = release.rating_count != null ? parseFloat(release.rating_count) : 0;
        if (avg !== null && cnt > 0) {
          globalWeightedSum += avg * cnt;
          globalRatingsCount += cnt;
          labelData.ratingWeightedSum += avg * cnt;
          labelData.ratingCountSum += cnt;
        }
      });
    });

    const C = globalRatingsCount > 0 ? globalWeightedSum / globalRatingsCount : 0;
    const m = 50;
    const labelsArray = Array.from(labelsMap.values()).map((l) => {
      const v = l.ratingCountSum;
      const R = v > 0 ? l.ratingWeightedSum / v : 0;
      l.averageRating = R;
      l.bayes_rating = v > 0 ? (v / (v + m)) * R + (m / (v + m)) * C : 0;
      return l;
    });

    return labelsArray;
  } catch (error) {
    console.error("Error in fetchLabelsData:", error);
    return [];
  }
}

async function loadLabelsData() {
  try {
    const tbody = document.getElementById("releases-table-body");
    tbody.innerHTML = `<tr><td class="no-results" colspan="3">
      <div class="spinner-border text-primary" role="status">
        <span class="visually-hidden">Loading...</span>
      </div>
      <p>Loading labels...</p>
    </td></tr>`;

    labelsData = await fetchLabelsData();
    totalRecords = labelsData.length;
    totalPages = Math.ceil(totalRecords / pageSize) || 1;
    currentPage = 1;
    
    // Set default sort for labels to name ascending if no sort is set
    if (!sortConfig.key || !["name", "releases", "averageRating"].includes(sortConfig.key)) {
      sortConfig.key = "name";
      sortConfig.order = "asc";
    }
    
    // Apply sorting
    sortLabelsData();
    
    // Paginate
    filteredData = labelsData.slice((currentPage - 1) * pageSize, currentPage * pageSize);
    
    renderLabelsTable();
    renderPagination();
    document.getElementById("pagination").style.display = "block";
  } catch (error) {
    console.error("Error in loadLabelsData:", error);
    const tbody = document.getElementById("releases-table-body");
    tbody.innerHTML = `<tr><td class="no-results" colspan="3">
      <i class="bi bi-exclamation-triangle-fill"></i>
      <p>An error occurred while loading labels. Please try again.</p>
    </td></tr>`;
  }
}

function sortLabelsData() {
  labelsData.sort((a, b) => {
    let aVal = a[sortConfig.key];
    let bVal = b[sortConfig.key];
    
    if (sortConfig.key === "name") {
      aVal = aVal ? aVal.toLowerCase() : "";
      bVal = bVal ? bVal.toLowerCase() : "";
    } else {
      aVal = parseFloat(aVal) || 0;
      bVal = parseFloat(bVal) || 0;
    }
    
    if (aVal < bVal) return sortConfig.order === "asc" ? -1 : 1;
    if (aVal > bVal) return sortConfig.order === "asc" ? 1 : -1;
    return 0;
  });
}

// Pagination functions for artists and labels
function loadArtistsPage(page = 1) {
  currentPage = page;
  sortArtistsData();
  filteredData = artistsData.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  renderArtistsTable();
  renderPagination();
}

function loadLabelsPage(page = 1) {
  currentPage = page;
  sortLabelsData();
  filteredData = labelsData.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  renderLabelsTable();
  renderPagination();
}

// ------------------ Load Bookmarked Releases ------------------
function loadBookmarks(page = 1) {
  let bookmarks = getBookmarkedReleases();
   // Apply filter criteria from the filter box:
   const searchQuery = document.getElementById("searchInput").value.trim().toLowerCase();
   const selectedGenre = document.getElementById("genre").value;
   const selectedStyle = document.getElementById("style").value;
   const { min: yearMin, max: yearMax } = parseYearRange();
   const ratingRange = parseRangeInput(document.getElementById("rating_range").value.trim());
   const ratingCountRange = parseRangeInput(document.getElementById("rating_count_range").value.trim());
   const priceRange = parseRangeInput(document.getElementById("price_range").value.trim());
 
   bookmarks = bookmarks.filter(release => {
     let pass = true;
     if (searchQuery && release.title) {
       if (!release.title.toLowerCase().includes(searchQuery)) pass = false;
     }
     if (selectedGenre) {
       if (release.genre) {
         const genres = release.genre.split(",").map(g => g.trim());
         if (!genres.includes(selectedGenre)) pass = false;
       } else {
         pass = false;
       }
     }
     if (selectedStyle) {
       if (release.style) {
         const styles = release.style.split(",").map(s => s.trim());
         if (!styles.includes(selectedStyle)) pass = false;
       } else {
         pass = false;
       }
     }
     if (release.year) {
       const yr = parseInt(release.year, 10);
       if (yr < yearMin || yr > yearMax) pass = false;
     }
     if (release.average_rating !== undefined) {
       const rating = parseFloat(release.average_rating);
       if (rating < ratingRange.min || rating > ratingRange.max) pass = false;
     }
     if (release.rating_count !== undefined) {
       const count = parseFloat(release.rating_count);
       if (count < ratingCountRange.min || count > ratingCountRange.max) pass = false;
     }
     if (release.lowest_price !== undefined) {
       const price = parseFloat(release.lowest_price);
       if (price < priceRange.min || price > priceRange.max) pass = false;
     }
     return pass;
   });
 
   // Sort bookmarks (default: most recent bookmarked first)
   if (!sortConfig || sortConfig.key === "title") {
     bookmarks.sort((a, b) => new Date(b.bookmarkedAt) - new Date(a.bookmarkedAt));
   } else {
     bookmarks.sort((a, b) => {
       let aVal = a[sortConfig.key];
       let bVal = b[sortConfig.key];
       if (sortConfig.key === "title" || sortConfig.key === "label") {
         aVal = aVal ? aVal.toLowerCase() : "";
         bVal = bVal ? bVal.toLowerCase() : "";
       } else if (["year", "have", "want", "lowest_price"].includes(sortConfig.key)) {
         aVal = parseFloat(aVal) || 0;
         bVal = parseFloat(bVal) || 0;
       } else if (sortConfig.key === "rating_coeff") {
         aVal = parseFloat(a.rating_coeff) || 0;
         bVal = parseFloat(b.rating_coeff) || 0;
       }
       if (aVal < bVal) return sortConfig.order === "asc" ? -1 : 1;
       if (aVal > bVal) return sortConfig.order === "asc" ? 1 : -1;
       return 0;
     });
   }
   // Filtering logic (omitted for brevity)
  totalRecords = bookmarks.length;
  totalPages = Math.ceil(totalRecords / pageSize) || 1;
  currentPage = page;
  filteredData = bookmarks.slice((page - 1) * pageSize, page * pageSize);
  renderTable();
  renderPagination();
  document.getElementById("pagination").style.display = "block";
}


// ------------------ Initialize Filters ------------------
let filtersCache = null;

async function initializeFilters() {
  // Check if we have cached filter data
  const cachedFilters = localStorage.getItem('filtersCache');
  const cacheTimestamp = localStorage.getItem('filtersCacheTimestamp');
  const now = Date.now();
  const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

  if (cachedFilters && cacheTimestamp && (now - parseInt(cacheTimestamp)) < CACHE_DURATION) {
    // Use cached data
    const { genres, styles } = JSON.parse(cachedFilters);
    populateFilterOptions(genres, styles);
    return;
  }

  // Fetch fresh data
  try {
    const { data, error } = await supabaseClient.from("releases").select("genre, style").limit(2000);
    if (error) {
      console.error("Error loading genres/styles:", error);
      return;
    }
    
    const genresSet = new Set();
    const stylesSet = new Set();
    data.forEach((row) => {
      if (row.genre) {
        row.genre.split(",").forEach((g) => {
          if (g.trim()) genresSet.add(g.trim());
        });
      }
      if (row.style) {
        row.style.split(",").forEach((s) => {
          if (s.trim()) stylesSet.add(s.trim());
        });
      }
    });
    
    const genres = Array.from(genresSet).sort();
    const styles = Array.from(stylesSet).sort();
    
    // Cache the results
    localStorage.setItem('filtersCache', JSON.stringify({ genres, styles }));
    localStorage.setItem('filtersCacheTimestamp', now.toString());
    
    populateFilterOptions(genres, styles);
  } catch (error) {
    console.error("Error initializing filters:", error);
  }
}

function populateFilterOptions(genres, styles) {
  const genreSelect = document.getElementById("genre");
  genreSelect.innerHTML = '<option value="">All Genres</option>';
  genres.forEach((genre) => {
    const option = document.createElement("option");
    option.value = genre;
    option.textContent = genre;
    genreSelect.appendChild(option);
  });
  
  const styleSelect = document.getElementById("style");
  styleSelect.innerHTML = '<option value="">All Styles</option>';
  styles.forEach((style) => {
    const option = document.createElement("option");
    option.value = style;
    option.textContent = style;
    styleSelect.appendChild(option);
  });
}

document.getElementById("mobile-filters-toggle").addEventListener("click", function() {
  const extraFilters = document.querySelector(".mobile-extra-filters-wrapper");
  if (extraFilters.style.display === "block") {
    extraFilters.style.display = "none";
    this.innerHTML = '<i class="bi bi-chevron-down"></i>';
  } else {
    extraFilters.style.display = "block";
    this.innerHTML = '<i class="bi bi-chevron-up"></i>';
  }
});

// ------------------ Render Table Headers ------------------
function renderTableHeaders(type) {
  const thead = document.getElementById("table-header");
  thead.innerHTML = "";
  
  const tr = document.createElement("tr");
  
  if (type === "artists") {
    // Artists table headers
    const headers = [
      { text: "Artist Name", sort: "name", width: "min-width: 300px" },
      { text: "Release Count", sort: "releases", width: "width: 150px", center: true },
      { text: "Average Rating", sort: "bayes_rating", width: "width: 180px", center: true }
    ];
    
    headers.forEach(header => {
      const th = document.createElement("th");
      th.scope = "col";
      th.setAttribute("data-column", header.text);
      th.setAttribute("data-sort", header.sort);
      th.style.cssText = header.width;
      if (header.center) th.className = "text-center";
      th.innerHTML = `${header.text}<div class="resizer"></div>`;
      tr.appendChild(th);
    });
  } else if (type === "labels") {
    // Labels table headers
    const headers = [
      { text: "Label Name", sort: "name", width: "min-width: 300px" },
      { text: "Release Count", sort: "releases", width: "width: 150px", center: true },
      { text: "Average Rating", sort: "bayes_rating", width: "width: 180px", center: true }
    ];
    
    headers.forEach(header => {
      const th = document.createElement("th");
      th.scope = "col";
      th.setAttribute("data-column", header.text);
      th.setAttribute("data-sort", header.sort);
      th.style.cssText = header.width;
      if (header.center) th.className = "text-center";
      th.innerHTML = `${header.text}<div class="resizer"></div>`;
      tr.appendChild(th);
    });
  } else {
    // Default releases table headers
    const headers = [
      { text: "Title", sort: "title", width: "min-width: 160px" },
      { text: "Label", sort: "label", width: "min-width: 120px" },
      { text: "Year", sort: "year", width: "width: 70px", center: true },
      { text: "Genre / Style", sort: "NO_SORT", width: "min-width: 150px" },
      { text: "User Rating", sort: "USER_RATING", width: "width: 140px", center: true, tooltip: "Click to sort rating_coeff ascending/descending." },
      { text: "Rarity", sort: "demand_coeff", width: "width: 90px", center: true, tooltip: "Click to sort by Rarity (want/have ratio)." },
      { text: "Gem⟡", sort: "gem_value", width: "width: 90px", center: true, tooltip: "Click to sort by Gem (combines rating & rarity)." },
      { text: "Have", sort: "have", width: "width: 70px", center: true },
      { text: "Want", sort: "want", width: "width: 70px", center: true },
      { text: "Price", sort: "lowest_price", width: "width: 80px", center: true },
      { text: "", sort: "", width: "width: 40px" },
      { text: "Preview", sort: "", width: "width: 220px", center: true }
    ];
    
    headers.forEach((header, index) => {
      const th = document.createElement("th");
      th.scope = "col";
      if (header.text) {
        th.setAttribute("data-column", header.text);
        th.setAttribute("data-sort", header.sort);
      }
      th.style.cssText = header.width;
      if (header.center) th.className = "text-center";
      if (header.tooltip) {
        th.title = header.tooltip;
        th.setAttribute("data-bs-toggle", "tooltip");
        th.setAttribute("data-bs-placement", "top");
        th.setAttribute("data-bs-delay", '{"show":1000, "hide":100}');
      }
      th.innerHTML = `${header.text}${header.text && header.sort !== "" ? '<div class="resizer"></div>' : ""}`;
      tr.appendChild(th);
    });
  }
  
  thead.appendChild(tr);
  
  // Attach sorting handlers after creating headers
  attachSortingHandlers();
  // Update sort indicators
  updateSortIndicators();
}

// ------------------ Render Artists Table ------------------
function renderArtistsTable() {
  renderTableHeaders("artists");
  const tbody = document.getElementById("releases-table-body");
  tbody.innerHTML = "";
  document.getElementById("results-count").textContent = `Showing ${totalRecords} artist(s)`;
  
  if (filteredData.length === 0) {
    tbody.innerHTML = `<tr><td class="no-results" colspan="3">
      <i class="bi bi-exclamation-triangle-fill"></i>
      <p>No artists found.</p>
    </td></tr>`;
    return;
  }
  
  filteredData.forEach((artist) => {
    const tr = document.createElement("tr");
    
    // Artist Name
    const tdName = document.createElement("td");
    const a = document.createElement("a");
    a.href = "#";
    a.className = "text-decoration-none text-primary fw-semibold";
    a.textContent = artist.name;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      entityDetail = { type: 'artist', name: artist.name };
      activeTab = 'entity';
      loadEntityReleases('artist', artist.name, 1);
    });
    tdName.appendChild(a);
    tr.appendChild(tdName);
    
    // Release Count
    const tdReleases = document.createElement("td");
    tdReleases.className = "text-center";
    tdReleases.textContent = artist.releases;
    tr.appendChild(tdReleases);
    
    // Average Rating
    const tdRating = document.createElement("td");
    tdRating.className = "text-center";
    if (artist.bayes_rating > 0) {
      tdRating.innerHTML = `${generateStars(artist.bayes_rating)} ${artist.bayes_rating.toFixed(2)}`;
    } else {
      tdRating.innerHTML = '<div class="text-muted">No rating</div>';
    }
    tr.appendChild(tdRating);
    
    tbody.appendChild(tr);
  });
}

// ------------------ Render Labels Table ------------------
function renderLabelsTable() {
  renderTableHeaders("labels");
  const tbody = document.getElementById("releases-table-body");
  tbody.innerHTML = "";
  document.getElementById("results-count").textContent = `Showing ${totalRecords} label(s)`;
  
  if (filteredData.length === 0) {
    tbody.innerHTML = `<tr><td class="no-results" colspan="3">
      <i class="bi bi-exclamation-triangle-fill"></i>
      <p>No labels found.</p>
    </td></tr>`;
    return;
  }
  
  filteredData.forEach((label) => {
    const tr = document.createElement("tr");
    
    // Label Name
    const tdName = document.createElement("td");
    const a = document.createElement("a");
    a.href = "#";
    a.className = "text-decoration-none text-primary fw-semibold";
    a.textContent = label.name;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      entityDetail = { type: 'label', name: label.name };
      activeTab = 'entity';
      loadEntityReleases('label', label.name, 1);
    });
    tdName.appendChild(a);
    tr.appendChild(tdName);
    
    // Release Count
    const tdReleases = document.createElement("td");
    tdReleases.className = "text-center";
    tdReleases.textContent = label.releases;
    tr.appendChild(tdReleases);
    
    // Average Rating
    const tdRating = document.createElement("td");
    tdRating.className = "text-center";
    if (label.bayes_rating > 0) {
      tdRating.innerHTML = `${generateStars(label.bayes_rating)} ${label.bayes_rating.toFixed(2)}`;
    } else {
      tdRating.innerHTML = '<div class="text-muted">No rating</div>';
    }
    tr.appendChild(tdRating);
    
    tbody.appendChild(tr);
  });
}

// ------------------ Render Table ------------------
function renderTable() {
  // Use specific render functions for artists and labels
  if (activeTab === "artists") {
    renderArtistsTable();
    return;
  } else if (activeTab === "labels") {
    renderLabelsTable();
    return;
  }
  
  // Default releases table rendering
  renderTableHeaders("releases");
  if (activeTab !== 'entity') entityDetail = null; // keep entity context during drill-down
  const isMobile = window.innerWidth <= 768;
  const tbody = document.getElementById("releases-table-body");
  tbody.innerHTML = "";
  document.getElementById("results-count").textContent = `Showing ${totalRecords} result(s)`;
  if (filteredData.length === 0) {
    tbody.innerHTML = `<tr><td class="no-results" colspan="12">
          <i class="bi bi-exclamation-triangle-fill"></i>
          <p>No results found.</p>
        </td></tr>`;
    return;
  }
  filteredData.forEach((release) => {
    const tr = document.createElement("tr");
    tr.setAttribute("data-id", release.id);
    const interactedReleases = JSON.parse(localStorage.getItem("interactedReleases")) || [];
    if (interactedReleases.includes(release.id)) {
      tr.classList.add("greyed-out");
    }
    const tdBookmark = document.createElement("td");
    tdBookmark.className = "text-center";
    const bookmarkIcon = document.createElement("i");
    bookmarkIcon.style.fontSize = "1rem";
    bookmarkIcon.className = "bi bookmark-star " + (isBookmarked(release.id) ? "bi-bookmark-fill bookmarked" : "bi-bookmark");
    bookmarkIcon.title = "Toggle Bookmark";
    bookmarkIcon.addEventListener("click", () => {
      toggleBookmark(release);
    });
    tdBookmark.appendChild(bookmarkIcon);
    if (isMobile) {
      const tdMobile = document.createElement("td");
      tdMobile.className = "mobile-cell";
      tdMobile.style.position = "relative";
      let previewContent = "";
      if (release.youtube_links) {
        const links = release.youtube_links.split(",").map((l) => l.trim()).filter((l) => l);
        if (links.length > 0) {
          const yID = extractYouTubeID(links[0]);
          if (yID) {
            previewContent = `<div class="mobile-preview">
              <iframe id="youtube-player-${release.id}" class="table-iframe" loading="lazy" title="YouTube video player" aria-label="YouTube video player" src="https://www.youtube.com/embed/${yID}?enablejsapi=1&rel=0&modestbranding=1" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
            </div>`;
          } else {
            previewContent = `<div class="mobile-preview text-muted">Invalid YouTube link</div>`;
          }
        } else {
          previewContent = `<div class="mobile-preview text-muted">No YouTube links</div>`;
        }
      } else {
        previewContent = `<div class="mobile-preview text-muted">No YouTube links</div>`;
      }
      const titleDiv = document.createElement("div");
      titleDiv.className = "mobile-title";
      const titleLink = document.createElement("a");
      titleLink.href = release.link;
      titleLink.target = "_blank";
      titleLink.rel = "noopener noreferrer";
      titleLink.className = "text-decoration-none text-primary fw-semibold";
      titleLink.textContent = release.title;
      titleLink.addEventListener("click", () => {
        markAsInteracted(release.id);
        tr.classList.add("greyed-out");
        trackReleaseLinkClick(release);
      });
      const copyBtn = document.createElement("button");
      copyBtn.className = "copy-btn";
      copyBtn.setAttribute("data-title", release.title);
      copyBtn.title = "Copy Title";
      copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>';
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(release.title).then(() => {
          markAsInteracted(release.id);
          tr.classList.add("greyed-out");
          const originalTitle = copyBtn.title;
          copyBtn.title = "Copied!";
          const tooltip = new bootstrap.Tooltip(copyBtn, { container: "body", trigger: "manual" });
          tooltip.show();
          setTimeout(() => {
            copyBtn.title = originalTitle;
            tooltip.hide();
            tooltip.dispose();
          }, 1500);
          trackCopyButtonClick(release);
        });
      });
      titleDiv.appendChild(titleLink);
      titleDiv.appendChild(copyBtn);
      const ratingDiv = document.createElement("div");
      ratingDiv.className = "mobile-rating";
      if (release.average_rating !== undefined && release.rating_count !== undefined) {
        ratingDiv.innerHTML = `${generateStars(release.average_rating)} ${parseFloat(release.average_rating).toFixed(1)} (${release.rating_count})`;
      } else {
        ratingDiv.innerHTML = `<div class="text-muted">No rating</div>`;
      }
      tdMobile.innerHTML += previewContent;
      tdMobile.appendChild(titleDiv);
      tdMobile.appendChild(ratingDiv);
      const mobileBookmarkContainer = document.createElement("div");
      mobileBookmarkContainer.className = "mobile-bookmark";
      mobileBookmarkContainer.style.position = "absolute";
      mobileBookmarkContainer.style.bottom = "8px";
      mobileBookmarkContainer.style.right = "8px";
      mobileBookmarkContainer.appendChild(tdBookmark);
      tdMobile.appendChild(mobileBookmarkContainer);
      tr.appendChild(tdMobile);
    } else {
      const tdTitle = document.createElement("td");
      const titleDiv = document.createElement("div");
      titleDiv.className = "d-flex align-items-center";
      const titleLink = document.createElement("a");
      titleLink.href = release.link;
      titleLink.target = "_blank";
      titleLink.rel = "noopener noreferrer";
      titleLink.className = "text-decoration-none text-primary fw-semibold";
      titleLink.textContent = release.title;
      titleLink.addEventListener("click", () => {
        markAsInteracted(release.id);
        tr.classList.add("greyed-out");
        trackReleaseLinkClick(release);
      });
      const copyBtn = document.createElement("button");
      copyBtn.className = "copy-btn";
      copyBtn.setAttribute("data-title", release.title);
      copyBtn.title = "Copy Title";
      copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>';
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(release.title).then(() => {
          markAsInteracted(release.id);
          tr.classList.add("greyed-out");
          const originalTitle = copyBtn.title;
          copyBtn.title = "Copied!";
          const tooltip = new bootstrap.Tooltip(copyBtn, { container: "body", trigger: "manual" });
          tooltip.show();
          setTimeout(() => {
            copyBtn.title = originalTitle;
            tooltip.hide();
            tooltip.dispose();
          }, 1500);
          trackCopyButtonClick(release);
        });
      });
      titleDiv.appendChild(titleLink);
      titleDiv.appendChild(copyBtn);
      tdTitle.appendChild(titleDiv);
      tr.appendChild(tdTitle);
      const tdLabel = document.createElement("td");
      tdLabel.textContent = release.label || "Unknown";
      tr.appendChild(tdLabel);
      const tdYear = document.createElement("td");
      tdYear.className = "text-center";
      tdYear.textContent = release.year || "N/A";
      tr.appendChild(tdYear);
      const tdGenreStyle = document.createElement("td");
      if (release.genre) {
        release.genre.split(",").forEach((g) => {
          const span = document.createElement("span");
          span.className = "badge-genre";
          span.textContent = g.trim();
          tdGenreStyle.appendChild(span);
        });
      }
      if (release.style) {
        release.style.split(",").forEach((s) => {
          const span = document.createElement("span");
          span.className = "badge-style";
          span.textContent = s.trim();
          tdGenreStyle.appendChild(span);
        });
      }
      tr.appendChild(tdGenreStyle);
      const tdRating = document.createElement("td");
      tdRating.className = "text-center";
      if (release.average_rating !== undefined && release.rating_count !== undefined) {
        tdRating.innerHTML = `${generateStars(release.average_rating)} ${parseFloat(release.average_rating).toFixed(1)} (${release.rating_count})`;
      } else {
        tdRating.innerHTML = '<div class="text-muted">No rating</div>';
      }
      tr.appendChild(tdRating);
      const tdRarity = document.createElement("td");
      tdRarity.className = "text-center";
      tdRarity.textContent = release.demand_coeff ? parseFloat(release.demand_coeff).toFixed(2) : "0.00";
      tr.appendChild(tdRarity);
      const tdGem = document.createElement("td");
      tdGem.className = "text-center";
      tdGem.textContent = release.gem_value ? parseFloat(release.gem_value).toFixed(2) : "0.00";
      tr.appendChild(tdGem);
      const tdHave = document.createElement("td");
      tdHave.className = "text-center";
      tdHave.textContent = release.have || 0;
      tr.appendChild(tdHave);
      const tdWant = document.createElement("td");
      tdWant.className = "text-center";
      tdWant.textContent = release.want || 0;
      tr.appendChild(tdWant);
      const tdPrice = document.createElement("td");
      tdPrice.className = "text-center";
      tdPrice.textContent = release.lowest_price !== undefined ? `${parseFloat(release.lowest_price).toFixed(2)}$` : "N/A";
      tr.appendChild(tdPrice);
      tr.appendChild(tdBookmark);
      const tdPreview = document.createElement("td");
      tdPreview.className = "text-center";
      if (release.youtube_links) {
        const links = release.youtube_links.split(",").map((l) => l.trim()).filter((l) => l);
        if (links.length > 0) {
          const yID = extractYouTubeID(links[0]);
          if (yID) {
            const iframe = document.createElement("iframe");
            iframe.id = `youtube-player-${release.id}`;
            iframe.className = "table-iframe";
            iframe.loading = "lazy";
            iframe.title = "YouTube video player";
            iframe.setAttribute("aria-label", "YouTube video player");
            iframe.src = `https://www.youtube.com/embed/${yID}?enablejsapi=1&rel=0&modestbranding=1`;
            iframe.frameBorder = "0";
            iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
            iframe.allowFullscreen = true;
            iframe.style.width = "220px";
            iframe.style.height = "124px";
            const iframeContainer = document.createElement("div");
            iframeContainer.style.position = "relative";
            iframeContainer.style.display = "inline-block";
            iframeContainer.appendChild(iframe);
            tdPreview.appendChild(iframeContainer);
          } else {
            tdPreview.innerHTML = '<div class="text-muted">Invalid YouTube link</div>';
          }
        } else {
          tdPreview.innerHTML = '<div class="text-muted">No YouTube links</div>';
        }
      } else {
        tdPreview.innerHTML = '<div class="text-muted">No YouTube links</div>';
      }
      tr.appendChild(tdPreview);
    }
    tbody.appendChild(tr);
  });
  attachCopyHandlers();
  if (youtubeApiReady) {
    initializeYouTubePlayers();
  }
}

function markAsInteracted(releaseId) {
  let interacted = JSON.parse(localStorage.getItem("interactedReleases")) || [];
  if (!interacted.includes(releaseId)) {
    interacted.push(releaseId);
    localStorage.setItem("interactedReleases", JSON.stringify(interacted));
  }
}

function generateStars(avg) {
  const average = parseFloat(avg) || 0;
  const fullStars = Math.floor(average);
  const halfStar = average % 1 >= 0.5 ? 1 : 0;
  const emptyStars = 5 - fullStars - halfStar;
  let starsHtml = "";
  for (let i = 0; i < fullStars; i++) {
    starsHtml += '<i class="bi bi-star-fill text-warning"></i>';
  }
  if (halfStar) {
    starsHtml += '<i class="bi bi-star-half text-warning"></i>';
  }
  for (let i = 0; i < emptyStars; i++) {
    starsHtml += '<i class="bi bi-star text-warning"></i>';
  }
  return starsHtml;
}

function extractYouTubeID(url) {
  const regex = /(?:youtube\.com\/.*v=|youtu\.be\/)([^"&?/\s]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

function attachCopyHandlers() {
  document.querySelectorAll(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const text = btn.getAttribute("data-title");
      if (text) {
        navigator.clipboard.writeText(text);
      }
    });
  });
}

// ------------------ Pagination ------------------
function renderPagination() {
  const pag = document.getElementById("pagination");
  pag.innerHTML = "";
  if (totalPages <= 1) return;
  const prevLi = document.createElement("li");
  prevLi.className = `page-item ${currentPage === 1 ? "disabled" : ""}`;
  const prevLink = document.createElement("a");
  prevLink.className = "page-link";
  prevLink.href = "#";
  prevLink.innerHTML = `<i class="bi bi-chevron-left"></i> Prev`;
  prevLink.addEventListener("click", (e) => {
    e.preventDefault();
    if (currentPage > 1) {
      if (activeTab === "bookmark") {
        loadBookmarks(currentPage - 1);
      } else if (activeTab === "artists") {
        loadArtistsPage(currentPage - 1);
      } else if (activeTab === "labels") {
        loadLabelsPage(currentPage - 1);
      } else if (activeTab === "entity" && entityDetail) {
        loadEntityReleases(entityDetail.type, entityDetail.name, currentPage - 1);
      } else {
        loadData(currentPage - 1);
      }
    }
  });
  prevLi.appendChild(prevLink);
  pag.appendChild(prevLi);
  const startPage = Math.max(1, currentPage - 2);
  const endPage = Math.min(totalPages, currentPage + 2);
  for (let p = startPage; p <= endPage; p++) {
    const pageLi = document.createElement("li");
    pageLi.className = `page-item ${p === currentPage ? "active" : ""}`;
    const pageLink = document.createElement("a");
    pageLink.className = "page-link";
    pageLink.href = "#";
    pageLink.textContent = p;
    pageLink.addEventListener("click", (e) => {
      e.preventDefault();
      if (activeTab === "bookmark") {
        loadBookmarks(p);
      } else if (activeTab === "artists") {
        loadArtistsPage(p);
      } else if (activeTab === "labels") {
        loadLabelsPage(p);
      } else if (activeTab === "entity" && entityDetail) {
        loadEntityReleases(entityDetail.type, entityDetail.name, p);
      } else {
        loadData(p);
      }
    });
    pageLi.appendChild(pageLink);
    pag.appendChild(pageLi);
  }
  const nextLi = document.createElement("li");
  nextLi.className = `page-item ${currentPage === totalPages ? "disabled" : ""}`;
  const nextLink = document.createElement("a");
  nextLink.className = "page-link";
  nextLink.href = "#";
  nextLink.innerHTML = `Next <i class="bi bi-chevron-right"></i>`;
  nextLink.addEventListener("click", (e) => {
    e.preventDefault();
    if (currentPage < totalPages) {
      if (activeTab === "bookmark") {
        loadBookmarks(currentPage + 1);
      } else if (activeTab === "artists") {
        loadArtistsPage(currentPage + 1);
      } else if (activeTab === "labels") {
        loadLabelsPage(currentPage + 1);
      } else if (activeTab === "entity" && entityDetail) {
        loadEntityReleases(entityDetail.type, entityDetail.name, currentPage + 1);
      } else {
        loadData(currentPage + 1);
      }
    }
  });
  nextLi.appendChild(nextLink);
  pag.appendChild(nextLi);
}

// ------------------ Make Table Columns Resizable ------------------
function makeTableResizable() {
  document.querySelectorAll("th[data-column]").forEach((th) => {
    const resizer = th.querySelector(".resizer");
    if (!resizer) return;
    let startX, startWidth;
    resizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      startX = e.pageX;
      startWidth = th.offsetWidth;
      document.body.classList.add("resizing");
      const onMouseMove = (e) => {
        const dx = e.pageX - startX;
        const newWidth = startWidth + dx;
        if (newWidth > 50) th.style.width = newWidth + "px";
      };
      const onMouseUp = () => {
        document.body.classList.remove("resizing");
        saveColumnWidths();
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  });
}

function saveColumnWidths() {
  const widths = {};
  document.querySelectorAll("th[data-column]").forEach((th) => {
    widths[th.getAttribute("data-column")] = th.offsetWidth;
  });
  localStorage.setItem("tableColumnWidths", JSON.stringify(widths));
}

function applySavedColumnWidths() {
  const saved = JSON.parse(localStorage.getItem("tableColumnWidths"));
  if (saved) {
    document.querySelectorAll("th[data-column]").forEach((th) => {
      const col = th.getAttribute("data-column");
      if (saved[col]) th.style.width = saved[col] + "px";
    });
  }
}

// ------------------ Sorting ------------------
function attachSortingHandlers() {
  document.querySelectorAll("th[data-sort]").forEach((header) => {
    header.addEventListener("click", () => {
      const sortValue = header.getAttribute("data-sort");
      const colName = header.getAttribute("data-column");
      if (sortValue === "NO_SORT") return;
      if (sortValue === "USER_RATING") {
        if (sortConfig.key === "rating_coeff") {
          sortConfig.order = sortConfig.order === "asc" ? "desc" : "asc";
        } else {
          sortConfig.key = "rating_coeff";
          sortConfig.order = "desc";
        }
      } else {
        if (sortConfig.key === sortValue) {
          sortConfig.order = sortConfig.order === "asc" ? "desc" : "asc";
        } else {
          sortConfig.key = sortValue;
          sortConfig.order = "asc";
        }
      }
      localStorage.setItem("sortConfig", JSON.stringify(sortConfig));
      if (activeTab === "bookmark") {
        loadBookmarks(currentPage);
      } else if (activeTab === "artists") {
        loadArtistsPage(currentPage);
      } else if (activeTab === "labels") {
        loadLabelsPage(currentPage);
      } else if (activeTab === "entity" && entityDetail) {
        loadEntityReleases(entityDetail.type, entityDetail.name, currentPage);
      } else {
        loadData(currentPage);
      }
      updateSortIndicators();
    });
  });
}

function updateSortIndicators() {
  document.querySelectorAll("th[data-sort]").forEach((header) => {
    const sortValue = header.getAttribute("data-sort");
    const colName = header.getAttribute("data-column");
    header.innerHTML = colName;
    if (sortValue === "NO_SORT") {
      const res = document.createElement("div");
      res.className = "resizer";
      header.appendChild(res);
      return;
    }
    if (sortConfig.key === "rating_coeff" && sortValue === "USER_RATING") {
      header.innerHTML += sortConfig.order === "asc"
        ? '<i class="bi bi-arrow-up sort-indicator" title="rating_coeff ascending"></i>'
        : '<i class="bi bi-arrow-down sort-indicator" title="rating_coeff descending"></i>';
    } else if (sortConfig.key === sortValue) {
      header.innerHTML += sortConfig.order === "asc"
        ? '<i class="bi bi-arrow-up sort-indicator"></i>'
        : '<i class="bi bi-arrow-down sort-indicator"></i>';
    }
    const res = document.createElement("div");
    res.className = "resizer";
    header.appendChild(res);
  });
}

// ------------------ Drill-down: Releases for Artist/Label ------------------
async function loadEntityReleases(type, name, page = 1) {
  try {
    activeTab = 'entity';
    entityDetail = { type, name };
    const tbody = document.getElementById("releases-table-body");
    tbody.innerHTML = `<tr><td class="no-results" colspan="12">
      <div class="spinner-border text-primary" role="status">
        <span class="visually-hidden">Loading...</span>
      </div>
      <p>Loading ${type} releases...</p>
    </td></tr>`;

    let query = supabaseClient.from("releases").select("id,title,label,year,genre,style,average_rating,rating_count,demand_coeff,gem_value,have,want,lowest_price,youtube_links,link,rating_coeff", { count: "planned" });
    if (type === 'artist') {
      // Try artist column if it exists; otherwise fall back to title ilike
      query = query.or(`artist.ilike.%${name}%,title.ilike.%${name}%`);
    } else {
      query = query.ilike("label", `%${name}%`);
    }
    // Validate sort key against releases table columns
    const validReleaseSortKeys = new Set([
      "title",
      "label",
      "year",
      "rating_coeff",
      "demand_coeff",
      "gem_value",
      "have",
      "want",
      "lowest_price",
      "average_rating",
      "rating_count"
    ]);
    const sortKeyToUse = validReleaseSortKeys.has(sortConfig.key) ? sortConfig.key : "title";
    query = query.order(sortKeyToUse, { ascending: sortConfig.order === 'asc' });
    const start = (page - 1) * pageSize;
    const end = start + pageSize - 1;
    query = query.range(start, end);

    const { data, count, error } = await query;
    if (error) {
      console.error(`Error loading ${type} releases:`, error);
      tbody.innerHTML = `<tr><td class=\"no-results\" colspan=\"12\">\n        <i class=\"bi bi-exclamation-triangle-fill\"></i>\n        <p>Failed to load releases.</p>\n      </td></tr>`;
      return;
    }

    filteredData = data || [];
    totalRecords = count || filteredData.length;
    totalPages = Math.ceil(totalRecords / pageSize) || 1;
    currentPage = page;

    // Reuse releases table rendering
    renderTableHeaders("releases");
    const body = document.getElementById("releases-table-body");
    body.innerHTML = "";
    document.getElementById("results-count").textContent = `Showing ${totalRecords} ${type === 'artist' ? 'release(s) by' : 'release(s) on'} ${name}`;
    if (filteredData.length === 0) {
      body.innerHTML = `<tr><td class=\"no-results\" colspan=\"12\">\n        <i class=\"bi bi-exclamation-triangle-fill\"></i>\n        <p>No releases found.</p>\n      </td></tr>`;
    } else {
      // Use existing renderer by temporarily calling renderTable after setting filteredData
      renderTable();
    }
    renderPagination();
  } catch (e) {
    console.error('Error in loadEntityReleases:', e);
  }
}

// ------------------ Mobile Sorting Options ------------------
document.addEventListener("DOMContentLoaded", () => {
  const mobileSortSelect = document.getElementById("mobile-sort-select");
  const mobileSortToggle = document.getElementById("mobile-sort-toggle");
  if (mobileSortSelect) {
    mobileSortSelect.value = sortConfig.key;
    mobileSortSelect.addEventListener("change", () => {
      sortConfig.key = mobileSortSelect.value;
      localStorage.setItem("sortConfig", JSON.stringify(sortConfig));
      loadData(currentPage);
    });
  }
  if (mobileSortToggle) {
    mobileSortToggle.innerHTML = sortConfig.order === "asc" 
      ? '<i class="bi bi-arrow-up"></i>' 
      : '<i class="bi bi-arrow-down"></i>';
    mobileSortToggle.addEventListener("click", () => {
      sortConfig.order = sortConfig.order === "asc" ? "desc" : "asc";
      localStorage.setItem("sortConfig", JSON.stringify(sortConfig));
      mobileSortToggle.innerHTML = sortConfig.order === "asc" 
        ? '<i class="bi bi-arrow-up"></i>' 
        : '<i class="bi bi-arrow-down"></i>';
      loadData(currentPage);
    });
  }
  
  // ------------------ Import Discogs Collection functionality ------------------
  document.getElementById("import-discogs-btn").addEventListener("click", () => {
    document.getElementById("import-discogs-file").click();
  });
  document.getElementById("import-discogs-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) {
      importDiscogsCollection(file);
    }
  });

  sortConfig = JSON.parse(localStorage.getItem("sortConfig") || '{"key":"title","order":"asc"}');
  const navBookmark = document.getElementById("tab-bookmark");
  if (navBookmark) {
    navBookmark.innerHTML = '<i class="bi bi-bookmark"></i>';
  }
  initializeFilters().then(() => {
    if (activeTab === "search") {
      loadData(1);
    } else if (activeTab === "shuffle") {
      loadShuffleData();
    } else if (activeTab === "bookmark") {
      loadBookmarks(1);
    }
  });
  applySavedColumnWidths();
  makeTableResizable();
  attachSortingHandlers();
  updateSortIndicators();
  updateFilterButtons();
  document.getElementById("filter-form").addEventListener("submit", (e) => {
    e.preventDefault();
    trackFilterApplied();
    if (activeTab === "search") {
      loadData(1);
    } else if (activeTab === "shuffle") {
      loadShuffleData();
    } else if (activeTab === "bookmark") {
      loadBookmarks(1);
    }
  });
  // Debounced filter change handler
  let filterTimeout;
  function handleFilterChange() {
    clearTimeout(filterTimeout);
    filterTimeout = setTimeout(() => {
      trackFilterApplied();
      if (activeTab === "search") {
        loadData(1);
      } else if (activeTab === "shuffle") {
        loadShuffleData();
      } else if (activeTab === "bookmark") {
        loadBookmarks(1);
      }
    }, 300); // 300ms debounce
  }

  document.getElementById("genre").addEventListener("change", handleFilterChange);
  document.getElementById("style").addEventListener("change", handleFilterChange);
  
  // Add debouncing to range inputs
  document.getElementById("year_range").addEventListener("input", handleFilterChange);
  document.getElementById("rating_range").addEventListener("input", handleFilterChange);
  document.getElementById("rating_count_range").addEventListener("input", handleFilterChange);
  document.getElementById("price_range").addEventListener("input", handleFilterChange);
  const darkModeToggle = document.getElementById("darkModeToggle");
  if (localStorage.getItem("darkModeEnabled") === "true" || !localStorage.getItem("darkModeEnabled")) {
    document.body.classList.add("dark-mode");
  } else {
    document.body.classList.remove("dark-mode");
  }
  darkModeToggle.addEventListener("click", () => {
    if (document.body.classList.contains("dark-mode")) {
      document.body.classList.remove("dark-mode");
      localStorage.setItem("darkModeEnabled", "false");
    } else {
      document.body.classList.add("dark-mode");
      localStorage.setItem("darkModeEnabled", "true");
    }
  });
  document.getElementById("tab-search").addEventListener("click", (e) => {
    e.preventDefault();
    activeTab = "search";
    document.getElementById("tab-search").classList.add("active");
    document.getElementById("tab-shuffle").classList.remove("active");
    document.getElementById("tab-bookmark").classList.remove("active");
    document.getElementById("tab-artists").classList.remove("active");
    document.getElementById("tab-labels").classList.remove("active");
    updateFilterButtons();
    loadData(1);
    document.getElementById("searchInput").focus();
  });
  document.getElementById("tab-shuffle").addEventListener("click", (e) => {
    e.preventDefault();
    activeTab = "shuffle";
    document.getElementById("tab-shuffle").classList.add("active");
    document.getElementById("tab-search").classList.remove("active");
    document.getElementById("tab-bookmark").classList.remove("active");
    document.getElementById("tab-artists").classList.remove("active");
    document.getElementById("tab-labels").classList.remove("active");
    updateFilterButtons();
    loadShuffleData();
  });
  document.getElementById("tab-bookmark").addEventListener("click", (e) => {
    e.preventDefault();
    activeTab = "bookmark";
    document.getElementById("tab-bookmark").classList.add("active");
    document.getElementById("tab-search").classList.remove("active");
    document.getElementById("tab-shuffle").classList.remove("active");
    document.getElementById("tab-artists").classList.remove("active");
    document.getElementById("tab-labels").classList.remove("active");
    updateFilterButtons();
    loadBookmarks(1);
  });
  
  document.getElementById("tab-artists").addEventListener("click", (e) => {
    e.preventDefault();
    activeTab = "artists";
    document.getElementById("tab-artists").classList.add("active");
    document.getElementById("tab-search").classList.remove("active");
    document.getElementById("tab-shuffle").classList.remove("active");
    document.getElementById("tab-bookmark").classList.remove("active");
    document.getElementById("tab-labels").classList.remove("active");
    updateFilterButtons();
    loadArtistsData();
  });
  
  document.getElementById("tab-labels").addEventListener("click", (e) => {
    e.preventDefault();
    activeTab = "labels";
    document.getElementById("tab-labels").classList.add("active");
    document.getElementById("tab-search").classList.remove("active");
    document.getElementById("tab-shuffle").classList.remove("active");
    document.getElementById("tab-bookmark").classList.remove("active");
    document.getElementById("tab-artists").classList.remove("active");
    updateFilterButtons();
    loadLabelsData();
  });
  document.getElementById("shuffle-btn").addEventListener("click", (e) => {
    e.preventDefault();
    activeTab = "shuffle";
    document.getElementById("tab-shuffle").classList.add("active");
    document.getElementById("tab-search").classList.remove("active");
    document.getElementById("tab-bookmark").classList.remove("active");
    document.getElementById("tab-artists").classList.remove("active");
    document.getElementById("tab-labels").classList.remove("active");
    trackFilterApplied();
    loadShuffleData();
  });

  // Debounce search input to prevent too many requests
  let searchTimeout;
  document.getElementById("searchInput").addEventListener("input", (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      if (activeTab === "search") {
        loadData(1);
      }
    }, 500); // Wait 500ms after user stops typing
  });

  document.getElementById("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(searchTimeout); // Clear any pending timeout
      gtag("event", "search_query", {
        query: document.getElementById("searchInput").value.trim()
      });
      if (activeTab !== "search") {
        activeTab = "search";
        document.getElementById("tab-search").classList.add("active");
        document.getElementById("tab-shuffle").classList.remove("active");
        document.getElementById("tab-bookmark").classList.remove("active");
        updateFilterButtons();
      }
      loadData(1);
    }
  });

  document.getElementById("export-btn").addEventListener("click", exportUserData);
});

/* -----------------------
   New: CSV Parser & Discogs Collection Import
------------------------- */
async function importDiscogsCollection(file) {
  try {
    const csvText = await file.text();
    const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
    const rows = parsed.data;
    const releaseIds = rows
      .map(row => row.release_id)
      .filter(id => id !== undefined && id !== "");
    const uniqueIds = [...new Set(releaseIds.map(String))];
    if (uniqueIds.length === 0) {
      alert("No release_id values found in CSV.");
      return;
    }
    const { data, error } = await supabaseClient
      .from("releases")
      .select("*")
      .in("id", uniqueIds);
    if (error) {
      alert("Error querying releases from database.");
      return;
    }
    const bookmarked = getBookmarkedReleases();
    let importedCount = 0;
    uniqueIds.forEach(rid => {
      const match = data.find(item => String(item.id) === rid);
      if (match && !bookmarked.some(b => String(b.id) === rid)) {
        match.bookmarkedAt = new Date().toISOString();
        bookmarked.push(match);
        importedCount++;
      }
    });
    const failedCount = uniqueIds.length - data.length;
    saveBookmarkedReleases(bookmarked);
    if (activeTab === "bookmark") loadBookmarks(currentPage);
    alert(`Discogs Collection Import Completed. Imported: ${importedCount}, Failed: ${failedCount}`);
  } catch (err) {
    alert("Error processing CSV file.");
  }
}










/* -----------------------
   Tab Toggle and Filter Button Update
------------------------- */
function updateFilterButtons() {
  if (activeTab === "bookmark") {
    document.getElementById("filter-wrapper").style.display = "block";
    document.getElementById("bookmark-actions").style.display = "block";
    document.getElementById("pagination").style.display = "block";
  } else {
    document.getElementById("filter-wrapper").style.display = "block";
    document.getElementById("bookmark-actions").style.display = "none";
  }
  
  if (activeTab === "search") {
    document.querySelector(".filter-btn").style.display = "inline-block";
    document.querySelector(".shuffle-btn").style.display = "none";
    document.getElementById("pagination").style.display = "block";
  } else if (activeTab === "shuffle") {
    document.querySelector(".filter-btn").style.display = "none";
    document.querySelector(".shuffle-btn").style.display = "inline-block";
    document.getElementById("pagination").style.display = "none";
  } else if (activeTab === "bookmark") {
    document.querySelector(".filter-btn").style.display = "inline-block";
    document.querySelector(".shuffle-btn").style.display = "none";
    document.getElementById("pagination").style.display = "block";
  } else if (activeTab === "artists" || activeTab === "labels") {
    document.querySelector(".filter-btn").style.display = "none";
    document.querySelector(".shuffle-btn").style.display = "none";
    document.getElementById("pagination").style.display = "block";
    // Hide filter wrapper for artists and labels as they don't need filtering
    document.getElementById("filter-wrapper").style.display = "none";
  }
}

/* -----------------------
   YouTube Integration
------------------------- */
function initializeYouTubePlayers() {
  filteredData.forEach((release) => {
    if (release.youtube_links) {
      const yID = extractYouTubeID(release.youtube_links);
      if (yID) {
        const iframe = document.getElementById(`youtube-player-${release.id}`);
        if (iframe && typeof YT !== "undefined" && YT && YT.Player) {
          new YT.Player(iframe, {
            events: {
              onStateChange: (event) => {
                if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.ENDED) {
                  markAsInteracted(release.id);
                  const tr = iframe.closest("tr");
                  if (tr) tr.classList.add("greyed-out");
                }
              },
            },
          });
        }
      }
    }
  });
}

// ------------------ Export Discogs Data ------------------
function exportUserData() {
  const bookmarkedReleases = JSON.parse(localStorage.getItem("bookmarkedReleases") || "[]");
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(bookmarkedReleases, null, 2));
  const dlAnchorElem = document.createElement("a");
  dlAnchorElem.setAttribute("href", dataStr);
  dlAnchorElem.setAttribute("download", "discogs_bookmarks.json");
  dlAnchorElem.click();
}


/* -----------------------
   Event Tracking
------------------------- */
function trackFilterApplied() {
  const genre = document.getElementById("genre").value;
  const style = document.getElementById("style").value;
  const yearRange = document.getElementById("year_range").value.trim();
  const ratingRange = document.getElementById("rating_range").value.trim();
  const ratingCountRange = document.getElementById("rating_count_range").value.trim();
  const priceRange = document.getElementById("price_range").value.trim();
  gtag("event", "filter_applied", {
    genre: genre || "All",
    style: style || "All",
    year_range: yearRange || "All",
    rating_range: ratingRange || "All",
    rating_count_range: ratingCountRange || "All",
    price_range: priceRange || "All",
  });
}

function trackCopyButtonClick(release) {
  gtag("event", "copy_title", {
    title: release.title,
    label: release.label || "Unknown",
    release_id: release.id,
  });
}

function trackReleaseLinkClick(release) {
  gtag("event", "release_link_click", {
    title: release.title,
    label: release.label || "Unknown",
    release_id: release.id,
    url: release.link,
  });
}

/* -----------------------
   Cookie Popup Functionality
------------------------- */
document.addEventListener("DOMContentLoaded", function() {
  const cookiePopup = document.getElementById("cookie-popup");
  const cookieAcceptBtn = document.getElementById("cookie-accept-btn");
  if (!localStorage.getItem("cookieConsent")) {
    cookiePopup.style.display = "flex";
  } else {
    cookiePopup.style.display = "none";
  }
  cookieAcceptBtn.addEventListener("click", function() {
    localStorage.setItem("cookieConsent", "true");
    cookiePopup.style.display = "none";
  });
});