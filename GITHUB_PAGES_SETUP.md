# GitHub Pages Setup Guide

This project has been converted to a **fully static, client-side application** that runs entirely in the browser without any backend server. Perfect for hosting on GitHub Pages!

## 🚀 Quick Deployment to GitHub Pages

### 1. Push to GitHub

```bash
# Initialize git repository (if not already done)
git init

# Add the standalone index.html
git add index.html

# Commit
git commit -m "Add standalone GitHub Pages version"

# Add your GitHub repository as remote
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git

# Push to GitHub
git push -u origin main
```

### 2. Enable GitHub Pages

1. Go to your repository on GitHub
2. Click **Settings** → **Pages**
3. Under **Source**, select `main` branch
4. Select `/ (root)` folder
5. Click **Save**

Your site will be live at: `https://YOUR_USERNAME.github.io/YOUR_REPO/`

## 🔑 First-Time Setup

When you first visit the application, you'll be prompted to enter your Discogs API credentials:

1. **Get Discogs API Credentials:**
   - Go to https://www.discogs.com/settings/developers
   - Create a new application or use an existing one
   - Copy your **Consumer Key** and **Consumer Secret**

2. **Enter Credentials:**
   - The settings modal will open automatically on first use
   - Or click the gear icon ⚙️ in the navbar to open settings
   - Paste your credentials and click **Save Settings**

3. **Credentials are stored locally** in your browser's localStorage
   - They never leave your device
   - You can update them anytime via the settings menu

## ✨ Features

### Client-Side Architecture
- ✅ **No backend required** - runs entirely in the browser
- ✅ **Secure** - API credentials stored locally in localStorage
- ✅ **Fast** - direct API calls to Discogs
- ✅ **Persistent** - data cached in localStorage

### Core Functionality
- 🎵 Search any Discogs seller's inventory
- ⭐ View releases sorted by Bayesian rating
- 🎨 Filter by genre, style, artist, label, year, rating, and price
- 📊 See rarity scores (demand coefficient)
- 🎥 Embedded YouTube videos from Discogs
- 💾 **Resume interrupted jobs** - automatically saves progress
- ❌ **Cancel running jobs** - stop anytime
- 🔄 **Refresh data** - force update cached data

### New in This Version
- **Artist Column** - Now displayed to the right of the title
- **Settings Modal** - Easy credential management
- **Local Storage Persistence** - All data saved locally
- **Job Resumption** - Pick up where you left off
- **Cancel & Resume** - Full control over processing

## 📖 How to Use

1. **Enter Seller Username** in the search box
2. **Click Search** - the app will fetch inventory and ratings
3. **View Progress** - live updates as data loads
4. **Browse Results** - filter and sort as needed
5. **Data is Cached** - next search is instant (24-hour cache)

### Cancel & Resume
- Click **Cancel** during processing to stop
- Refresh the page - the app will ask to resume
- Processed data is saved - no need to start over

### Clear Data
- Click **Clear Data** to remove cached seller data
- Next search will fetch fresh data

## 🔧 Customization

The entire app is in one `index.html` file. You can easily customize:

- **Colors & Theme** - Edit CSS variables in the `<style>` section
- **Page Size** - Change `const pageSize = 10` in JavaScript
- **Cache Duration** - Modify the 24-hour check in `getCachedSellerData()`
- **Rate Limiting** - Adjust `MIN_REQUEST_INTERVAL` (default: 1 second)

## 🔒 Privacy & Security

- **No server** - everything runs in your browser
- **No tracking** - no analytics or external services (except Discogs API)
- **Local storage only** - your data never leaves your device
- **API credentials** - stored securely in browser localStorage
- **No cookies** - pure localStorage implementation

## 🌐 Browser Compatibility

Tested and working on:
- ✅ Chrome/Edge (Chromium)
- ✅ Firefox
- ✅ Safari
- ✅ Mobile browsers

Requires:
- Modern browser with localStorage support
- JavaScript enabled
- Internet connection (for Discogs API calls)

## ⚠️ Rate Limiting

Discogs API has rate limits (60 requests/minute for authenticated requests):
- The app automatically handles rate limiting
- Waits when necessary to avoid 429 errors
- Shows "Rate limited, waiting..." message if needed

## 🐛 Troubleshooting

### "Please configure your Discogs API credentials"
→ Click the gear icon ⚙️ and enter your credentials

### "Rate limited. Please wait 60 seconds"
→ The app is making too many requests. Wait and it will auto-resume

### Data not loading after refresh
→ Check browser console for errors
→ Ensure your API credentials are valid
→ Try clearing data and searching again

### Job stuck or not resuming
→ Open browser DevTools → Application → Local Storage
→ Look for `currentJobId` and `job_*` entries
→ Delete them and try again

## 📝 Development

The old backend files (`app.py`, `database.py`, etc.) are no longer needed for the GitHub Pages version. The entire application now runs client-side.

### File Structure for GitHub Pages:
```
.
├── index.html          ← The only file you need!
└── GITHUB_PAGES_SETUP.md
```

That's it! Everything else is optional.

## 🎉 Enjoy!

You now have a fully functional, serverless Discogs seller browser running on GitHub Pages!

**Star the repo if you find it useful! ⭐**

