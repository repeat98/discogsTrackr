# 🎵 Discogs Seller - Best Rated Releases (GitHub Pages Edition)

A **fully client-side** web application to browse and analyze Discogs seller inventories by ratings. No backend required! Perfect for GitHub Pages hosting.

## ✨ What's New in the GitHub Pages Version

### 🚀 **Fully Static & Serverless**
- No Python/Flask backend needed
- Runs entirely in your browser
- Perfect for GitHub Pages deployment
- Direct Discogs API integration

### 🔐 **Secure Credential Management**
- First-use setup wizard
- Credentials stored locally in browser
- Access via settings modal (⚙️ icon)
- Your data never leaves your device

### 💾 **Smart Local Storage**
- All data cached in browser
- 24-hour cache duration
- Resume interrupted jobs
- Cancel and continue later

### 🎨 **Enhanced UI**
- **Artist column** added (right of Title)
- Settings modal for easy configuration
- Progress tracking with cancel button
- Real-time data updates

## 🚀 Quick Start (GitHub Pages)

### 1. Deploy to GitHub Pages

```bash
# Push the index.html to your repo
git add index.html
git commit -m "Add Discogs Seller browser"
git push origin main

# Enable GitHub Pages in Settings → Pages
# Select main branch, / (root) folder
```

### 2. Get Discogs API Credentials

1. Visit https://www.discogs.com/settings/developers
2. Create a new application
3. Copy **Consumer Key** and **Consumer Secret**

### 3. Use the App

1. Open your GitHub Pages URL
2. Enter credentials in the settings modal
3. Search for any Discogs seller
4. Browse, filter, and sort releases!

## 📊 Features

### Core Functionality
- ✅ Search any Discogs seller by username
- ✅ View releases sorted by Bayesian rating
- ✅ **Artist column** displayed separately
- ✅ Embedded YouTube videos
- ✅ Real-time progress updates
- ✅ **Cancel & Resume** jobs anytime
- ✅ 24-hour data caching

### Filters & Sorting
- 🎨 Filter by Genre, Style, Artist, Label
- 📅 Year range filter
- ⭐ Rating range filter
- 💰 Price range filter
- 🔢 Rating count filter
- 📊 Sort by any column

### Data Insights
- ⭐ **Bayesian Rating** - Statistically adjusted scores
- 💎 **Rarity Score** - Demand coefficient (want/have ratio)
- 📈 Have/Want counts from Discogs community
- 🎥 Embedded YouTube videos from Discogs

## 🔧 How It Works

### Architecture
```
Browser (You)
    ↓
index.html (Single File App)
    ↓
localStorage (Cache & Credentials)
    ↓
Discogs API (Direct Calls)
```

### Data Flow
1. **Enter credentials** → Saved to localStorage
2. **Search seller** → Fetch inventory from Discogs
3. **Process releases** → Get ratings & details
4. **Cache results** → Save to localStorage (24h)
5. **Display & filter** → Interactive table

### Job Management
- **Create Job** → Store in localStorage with unique ID
- **Process Data** → Update progress incrementally
- **Cancel** → Set job status to 'cancelled'
- **Resume** → Check localStorage on page load
- **Complete** → Save final results, clear job

## 📋 Table Columns

| Column | Description | Sortable |
|--------|-------------|----------|
| **Title** | Release title | ✅ |
| **Artist** | Artist name | ✅ |
| **Label** | Record label | ✅ |
| **Year** | Release year | ✅ |
| **Genre/Style** | Combined genre & style badges | ❌ |
| **Rating** | Bayesian score + avg + count | ✅ |
| **Rarity** | Demand coefficient | ✅ |
| **# Ratings** | Number of ratings | ✅ |
| **Have** | Users who own it | ✅ |
| **Want** | Users who want it | ✅ |
| **Price** | Lowest listing price | ✅ |
| **Videos** | YouTube previews | ❌ |

## 🎯 Use Cases

### For Collectors
- Find highly-rated hidden gems in seller inventory
- Compare rarity scores to find valuable items
- Watch embedded videos before buying

### For Sellers
- Analyze your own inventory by rating
- Identify high-value items to feature
- Compare prices across releases

### For Music Fans
- Discover new music from trusted sellers
- Filter by genre/style/year to find specific sounds
- Research releases before purchasing

## 🔒 Privacy & Security

- ✅ **No server** - everything client-side
- ✅ **No tracking** - no analytics
- ✅ **No cookies** - uses localStorage only
- ✅ **API keys local** - never transmitted to any server except Discogs
- ✅ **Open source** - audit the code yourself

## ⚡ Performance

- **Fast initial load** - single HTML file
- **Smart caching** - 24-hour localStorage cache
- **Incremental updates** - see results as they load
- **Rate limiting** - automatic Discogs API compliance
- **Resume capability** - don't lose progress

## 🛠️ Customization

Edit `index.html` to customize:

### Colors (CSS Variables)
```css
:root {
  --accent-color: #E7FF6E;  /* Change highlight color */
  --bg-color: #E0E0E0;      /* Light mode background */
}
```

### Page Size
```javascript
const pageSize = 10;  // Change to 20, 50, etc.
```

### Cache Duration
```javascript
const ageHours = (Date.now() - data.timestamp) / (1000 * 60 * 60);
if (ageHours > 24) return null;  // Change 24 to desired hours
```

## 🐛 Troubleshooting

### Settings Modal Won't Open
- Ensure JavaScript is enabled
- Check browser console for errors
- Try clearing localStorage: DevTools → Application → Local Storage

### Job Won't Resume
- Open DevTools → Application → Local Storage
- Find `currentJobId` and `job_*` entries
- Delete them and try again

### Rate Limit Errors
- Discogs allows 60 requests/minute
- App auto-handles this, but may slow down
- Wait for "Rate limited, waiting..." message to clear

### No Results Showing
- Check API credentials in Settings
- Verify seller username is correct
- Check browser console for API errors

## 📱 Mobile Support

The app is fully responsive and works great on:
- 📱 iPhone/iPad (Safari)
- 📱 Android (Chrome)
- 💻 Desktop browsers (all modern browsers)

## 🔄 Migration from Backend Version

If you were using the Flask backend version:

### What Changed
- ❌ No more `app.py`, `database.py`, Python backend
- ✅ Everything now in `index.html`
- ✅ localStorage instead of SQLite
- ✅ Direct Discogs API calls instead of server proxy

### Migration Steps
1. Export any important data from SQLite (optional)
2. Use the new `index.html` file
3. Enter your API credentials in Settings
4. Re-search sellers (data will cache locally)

## 🌟 Key Improvements Over Backend Version

| Feature | Backend | GitHub Pages |
|---------|---------|--------------|
| **Deployment** | Requires Python server | Just upload HTML |
| **Hosting** | Railway/Heroku needed | Free GitHub Pages |
| **Setup** | Virtual env, dependencies | Just API credentials |
| **Database** | SQLite | localStorage |
| **Scaling** | Server resources | Browser only |
| **Offline** | No | Cached data yes |
| **Updates** | Restart server | Refresh page |

## 📚 Additional Documentation

- [Detailed GitHub Pages Setup](GITHUB_PAGES_SETUP.md)
- [Original Backend Docs](README.md) (if kept)

## 🎉 Credits

- Built for Discogs collectors and sellers
- Powered by Discogs API
- YouTube video integration
- Bootstrap 5 UI framework
- Google Fonts (Figtree)

## 📄 License

This project is open source. Feel free to fork, modify, and use!

## 🤝 Contributing

Found a bug? Have a feature idea?
- Open an issue on GitHub
- Submit a pull request
- Share your improvements!

---

**Made with ❤️ for the Discogs community**

Star ⭐ this repo if you find it useful!

