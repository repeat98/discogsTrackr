#!/usr/bin/env python3
"""
Script to fetch and display the best-rated releases from a Discogs seller.
"""

import os
import sys
import time
import math
import requests
import json
from requests_oauthlib import OAuth1
from typing import List, Tuple, Dict, Optional
from dotenv import load_dotenv
from urllib.parse import quote_plus

# Load environment variables
load_dotenv()


def bayesian_rating(average_rating: float, num_ratings: int, min_num_ratings: int = 10) -> float:
    """
    Calculate Bayesian average rating (Wilson Score approximation).
    
    This gives a more reliable ranking by considering both rating and number of ratings.
    Releases with few ratings are penalized, while those with many ratings are rewarded.
    
    Args:
        average_rating: The average rating (0-5 scale)
        num_ratings: Number of ratings
        min_num_ratings: Minimum number of ratings to consider "normalized"
        
    Returns:
        Bayesian rating adjusted for confidence
    """
    if num_ratings == 0:
        return 0.0
    
    # Bayesian average formula: (avg_rating * num_ratings + prior_mean * min_num_ratings) / (num_ratings + min_num_ratings)
    # Using 2.5 as prior mean (middle of 5-point scale)
    prior_mean = 2.5
    
    bayesian_avg = (average_rating * num_ratings + prior_mean * min_num_ratings) / (num_ratings + min_num_ratings)
    
    return bayesian_avg


class DiscogsSellerReleases:
    """Class to handle fetching and sorting Discogs seller releases by rating."""
    
    def __init__(self, consumer_key: str, consumer_secret: str, access_token: Optional[str] = None, 
                 access_token_secret: Optional[str] = None, user_agent: str = "Digger/1.0 (DiscogsBestRated)"):
        """
        Initialize the Discogs API client with OAuth authentication.
        
        Args:
            consumer_key: Discogs OAuth consumer key
            consumer_secret: Discogs OAuth consumer secret
            access_token: Optional OAuth access token (for OAuth 1.0 flow)
            access_token_secret: Optional OAuth access token secret (for OAuth 1.0 flow)
            user_agent: User agent string for API requests
        """
        self.consumer_key = consumer_key
        self.consumer_secret = consumer_secret
        self.access_token = access_token
        self.access_token_secret = access_token_secret
        self.user_agent = user_agent
        self.base_url = 'https://api.discogs.com'
        
        # Set up authentication
        self.auth = None
        if access_token and access_token_secret:
            # OAuth 1.0 authentication
            self.auth = OAuth1(
                consumer_key,
                client_secret=consumer_secret,
                resource_owner_key=access_token,
                resource_owner_secret=access_token_secret
            )
        
        self.headers = {
            'User-Agent': user_agent
        }
        
        # YouTube API key (optional, from environment)
        self.youtube_api_key = os.getenv('YOUTUBE_API_KEY')
        
        # Rate limiting state
        self.last_request_time = 0.0
        self.min_request_interval = 1.0  # Start conservative, will adjust based on headers
        
    def _check_rate_limit_headers(self, response: requests.Response):
        """
        Check and adjust rate limiting based on Discogs API headers.
        
        Args:
            response: The HTTP response object
        """
        # Discogs API provides these headers to help manage rate limits
        ratelimit = response.headers.get('X-Discogs-Ratelimit', '60')
        ratelimit_used = response.headers.get('X-Discogs-Ratelimit-Used', '0')
        ratelimit_remaining = response.headers.get('X-Discogs-Ratelimit-Remaining', '60')
        
        try:
            ratelimit = int(ratelimit)
            ratelimit_remaining = int(ratelimit_remaining)
            
            # Calculate optimal request interval: 60 seconds / requests per minute
            # Add buffer to be safe
            self.min_request_interval = (60.0 / ratelimit) * 1.1  # 10% buffer
            
            # If we're getting close to the limit, slow down more
            if ratelimit_remaining < 10:
                self.min_request_interval *= 2
                print(f"  Rate limit low ({ratelimit_remaining} remaining), slowing requests...")
                
        except (ValueError, ZeroDivisionError):
            pass  # Keep default if headers are invalid
    
    def _rate_limit_wait(self):
        """
        Wait if necessary to respect rate limits based on moving window.
        """
        current_time = time.time()
        time_since_last = current_time - self.last_request_time
        
        if time_since_last < self.min_request_interval:
            sleep_time = self.min_request_interval - time_since_last
            time.sleep(sleep_time)
        
        self.last_request_time = time.time()
        
    def get_seller_inventory(self, seller_username: str, page: int = 1, per_page: int = 100, 
                            max_retries: int = 3) -> Dict:
        """
        Fetch the seller's inventory from Discogs API with retry logic.
        
        Args:
            seller_username: The Discogs seller's username
            page: Page number (default: 1)
            per_page: Items per page (default: 100, max: 100)
            max_retries: Maximum number of retry attempts (default: 3)
            
        Returns:
            JSON response containing inventory listings
        """
        url = f"{self.base_url}/users/{seller_username}/inventory"
        params = {'page': page, 'per_page': per_page}
        
        for attempt in range(max_retries):
            try:
                # Wait before making request to respect rate limits
                self._rate_limit_wait()
                
                response = requests.get(url, headers=self.headers, params=params, auth=self.auth)
                
                # Update rate limiting based on headers
                self._check_rate_limit_headers(response)
                
                # Handle rate limiting (429 status code)
                if response.status_code == 429:
                    retry_after = int(response.headers.get('Retry-After', 60))
                    if attempt < max_retries - 1:
                        print(f"  Rate limited. Waiting {retry_after} seconds before retry...")
                        time.sleep(retry_after)
                        continue
                
                response.raise_for_status()
                return response.json()
                
            except requests.exceptions.RequestException as e:
                if attempt < max_retries - 1:
                    wait_time = 2 ** attempt  # Exponential backoff
                    print(f"  Error fetching page {page}: {e}")
                    print(f"  Retrying in {wait_time} seconds...")
                    time.sleep(wait_time)
                else:
                    print(f"Error fetching inventory after {max_retries} attempts: {e}")
                    raise
    
    def get_all_inventory_listings(self, seller_username: str) -> List[Dict]:
        """
        Fetch all inventory listings from the seller, handling pagination.
        
        Args:
            seller_username: The Discogs seller's username
            
        Returns:
            List of all inventory listings
        """
        all_listings = []
        page = 1
        per_page = 100
        
        print(f"Fetching inventory from seller '{seller_username}'...")
        
        while True:
            inventory = self.get_seller_inventory(seller_username, page=page, per_page=per_page)
            listings = inventory.get('listings', [])
            
            if not listings:
                break
                
            all_listings.extend(listings)
            print(f"  Fetched page {page}: {len(listings)} items")
            
            # Check if there are more pages
            pagination = inventory.get('pagination', {})
            if page >= pagination.get('pages', 1):
                break
            
            page += 1
        
        print(f"Total items found: {len(all_listings)}\n")
        return all_listings
    
    def get_release_details(self, release_id: int, max_retries: int = 3) -> Optional[Dict]:
        """
        Fetch full release details including rating, genres, styles, year, label, etc.
        
        Args:
            release_id: The Discogs release ID
            max_retries: Maximum number of retry attempts (default: 3)
            
        Returns:
            Dict with release details or None if failed
        """
        url = f"{self.base_url}/releases/{release_id}"
        
        for attempt in range(max_retries):
            try:
                # Wait before making request to respect rate limits
                self._rate_limit_wait()
                
                response = requests.get(url, headers=self.headers, auth=self.auth)
                
                # Update rate limiting based on headers
                self._check_rate_limit_headers(response)
                
                # Handle rate limiting (429 status code)
                if response.status_code == 429:
                    retry_after = int(response.headers.get('Retry-After', 60))
                    if attempt < max_retries - 1:
                        time.sleep(retry_after)
                        continue
                
                response.raise_for_status()
                release_data = response.json()
                
                # Extract rating data
                rating_data = release_data.get('community', {}).get('rating', {})
                avg_rating = float(rating_data.get('average', 0.0)) if rating_data.get('average') else 0.0
                num_ratings = int(rating_data.get('count', 0)) if rating_data.get('count') else 0
                
                # Extract have/want counts
                have_count = int(release_data.get('community', {}).get('have', 0))
                want_count = int(release_data.get('community', {}).get('want', 0))
                
                # Extract genres and styles
                genres = release_data.get('genres', [])
                styles = release_data.get('styles', [])
                
                # Extract year
                year = release_data.get('year')
                
                # Extract label
                labels = release_data.get('labels', [])
                label = labels[0].get('name') if labels else None
                
                # Extract artist and title
                artists_list = release_data.get('artists', [])
                artist = artists_list[0].get('name') if artists_list else 'Unknown Artist'
                title = release_data.get('title', 'Unknown Title')
                
                # Extract video URLs (YouTube links from Discogs)
                videos = release_data.get('videos', [])
                video_urls = []
                for video in videos:
                    if video.get('uri'):
                        video_urls.append({
                            'url': video['uri'],
                            'title': video.get('title', 'Video')
                        })
                
                return {
                    'avg_rating': avg_rating,
                    'num_ratings': num_ratings,
                    'have_count': have_count,
                    'want_count': want_count,
                    'genres': genres,
                    'styles': styles,
                    'year': year,
                    'label': label,
                    'artist': artist,
                    'title': title,
                    'videos': video_urls
                }
                
            except requests.exceptions.RequestException as e:
                if attempt < max_retries - 1:
                    wait_time = 2 ** attempt  # Exponential backoff
                    time.sleep(wait_time)
                    continue
                else:
                    # If we can't get the details after retries, return None
                    return None
    
    def get_release_rating(self, release_id: int, max_retries: int = 3) -> Tuple[float, int]:
        """
        Fetch the average community rating and count for a release with retry logic.
        (Legacy method - prefer get_release_details for new code)
        
        Args:
            release_id: The Discogs release ID
            max_retries: Maximum number of retry attempts (default: 3)
            
        Returns:
            Tuple of (average_rating, num_ratings)
        """
        details = self.get_release_details(release_id, max_retries)
        if details:
            return (details['avg_rating'], details['num_ratings'])
        return (0.0, 0)
    
    def search_youtube_video(self, artist: str, title: str) -> Optional[str]:
        """
        Search YouTube for a video matching the artist and title.
        
        Args:
            artist: Artist name
            title: Release title
            
        Returns:
            YouTube video ID if found, None otherwise
        """
        if not self.youtube_api_key:
            # Fallback: return a search query URL parameter that can be used client-side
            return None
        
        try:
            search_query = f"{artist} {title}"
            url = f"https://www.googleapis.com/youtube/v3/search"
            params = {
                'part': 'snippet',
                'q': search_query,
                'type': 'video',
                'maxResults': 1,
                'key': self.youtube_api_key
            }
            
            response = requests.get(url, params=params, timeout=5)
            if response.status_code == 200:
                data = response.json()
                items = data.get('items', [])
                if items:
                    return items[0]['id']['videoId']
            return None
        except Exception as e:
            print(f"YouTube search failed for {artist} - {title}: {e}")
            return None
    
    def get_releases_with_ratings(self, listings: List[Dict]) -> List[Tuple[int, str, float, float, int]]:
        """
        Extract release IDs from listings and fetch their ratings with Bayesian scoring.
        
        Args:
            listings: List of inventory listings
            
        Returns:
            List of tuples: (release_id, artist_title, bayesian_rating, avg_rating, num_ratings)
        """
        releases_with_ratings = []
        unique_releases = {}  # Track unique releases to avoid duplicates
        
        print("Fetching ratings for releases...")
        
        for listing in listings:
            release_info = listing.get('release', {})
            if not release_info:
                continue
                
            release_id = release_info.get('id')
            if not release_id:
                continue
            
            # Skip if we've already processed this release
            if release_id in unique_releases:
                continue
            
            # Build artist and title string
            artist = release_info.get('artist', 'Unknown Artist')
            title = release_info.get('title', 'Unknown Title')
            artist_title = f"{artist} - {title}"
            
            # Fetch rating and count
            avg_rating, num_ratings = self.get_release_rating(release_id)
            
            # Calculate Bayesian rating for sorting
            bayesian_score = bayesian_rating(avg_rating, num_ratings)
            
            unique_releases[release_id] = True
            releases_with_ratings.append((release_id, artist_title, bayesian_score, avg_rating, num_ratings))
            
            if len(releases_with_ratings) % 10 == 0:
                print(f"  Processed {len(releases_with_ratings)} releases...")
        
        print(f"Processed {len(releases_with_ratings)} unique releases\n")
        return releases_with_ratings
    
    def generate_html_output(self, sorted_releases: List[Tuple[int, str, float, float, int]], output_file: str = 'output.html'):
        """
        Generate an HTML file with clickable links to releases sorted by Bayesian rating.
        
        Args:
            sorted_releases: List of tuples (release_id, artist_title, bayesian_rating, avg_rating, num_ratings)
            output_file: Output filename
        """
        html_content = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Best Rated Discogs Releases</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            max-width: 900px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
        }
        h1 {
            color: #333;
            border-bottom: 3px solid #4CAF50;
            padding-bottom: 10px;
        }
        .release {
            background: white;
            margin: 10px 0;
            padding: 15px;
            border-radius: 5px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .release-info {
            flex-grow: 1;
        }
        .release-title {
            font-size: 1.1em;
            font-weight: bold;
            color: #333;
            margin-bottom: 5px;
        }
        .release-rating {
            color: #666;
            font-size: 0.9em;
        }
        .release-link {
            color: #4CAF50;
            text-decoration: none;
            font-weight: bold;
            padding: 8px 15px;
            border: 2px solid #4CAF50;
            border-radius: 4px;
            transition: all 0.3s;
        }
        .release-link:hover {
            background-color: #4CAF50;
            color: white;
        }
        .stats {
            background: white;
            padding: 15px;
            border-radius: 5px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .stats p {
            margin: 5px 0;
            color: #666;
        }
    </style>
</head>
<body>
    <h1>🎵 Best Rated Discogs Releases</h1>
    <div class="stats">
        <p><strong>Total Releases:</strong> {total_releases}</p>
        <p><strong>Average Rating:</strong> {avg_rating:.2f}</p>
        <p><strong>Highest Rating:</strong> {max_rating:.2f}</p>
    </div>
    <div class="releases">
"""
        
        # Calculate statistics
        total_releases = len(sorted_releases)
        ratings = [r[2] for r in sorted_releases if r[2] > 0]  # Bayesian ratings
        avg_rating = sum(ratings) / len(ratings) if ratings else 0
        max_rating = max(ratings) if ratings else 0
        
        # Replace placeholders
        html_content = html_content.format(
            total_releases=total_releases,
            avg_rating=avg_rating,
            max_rating=max_rating
        )
        
        # Add releases
        for release_id, artist_title, bayesian_score, avg_rating, num_ratings in sorted_releases:
            if avg_rating == 0:
                rating_display = "No rating"
            else:
                # Show average rating and count
                rating_display = f"⭐ {avg_rating:.2f} ({num_ratings} ratings)"
            
            release_link = f"https://www.discogs.com/release/{release_id}"
            
            html_content += f"""
        <div class="release">
            <div class="release-info">
                <div class="release-title">{artist_title}</div>
                <div class="release-rating">{rating_display}</div>
            </div>
            <a href="{release_link}" target="_blank" class="release-link">View on Discogs</a>
        </div>
"""
        
        html_content += """
    </div>
</body>
</html>
"""
        
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(html_content)
        
        print(f"✅ HTML output saved to {output_file}")
    
    def run(self, seller_username: str, output_file: str = 'output.html'):
        """
        Main execution method.
        
        Args:
            seller_username: The Discogs seller's username
            output_file: Output HTML filename
        """
        # Fetch all inventory listings
        listings = self.get_all_inventory_listings(seller_username)
        
        if not listings:
            print("No listings found for this seller.")
            return
        
        # Get releases with ratings
        releases_with_ratings = self.get_releases_with_ratings(listings)
        
        # Sort by Bayesian rating (descending)
        sorted_releases = sorted(releases_with_ratings, key=lambda x: x[2], reverse=True)
        
        # Filter out releases with no rating if desired (optional)
        # Uncomment the next line to only show releases with ratings
        # sorted_releases = [r for r in sorted_releases if r[3] > 0]
        
        # Generate HTML output
        self.generate_html_output(sorted_releases, output_file)
        
        # Also print to console
        print("\n" + "="*80)
        print("TOP RATED RELEASES (Bayesian Score)")
        print("="*80)
        for i, (release_id, artist_title, bayesian_score, avg_rating, num_ratings) in enumerate(sorted_releases[:20], 1):
            release_link = f"https://www.discogs.com/release/{release_id}"
            if avg_rating > 0:
                rating_display = f"⭐ {avg_rating:.2f} ({num_ratings})"
            else:
                rating_display = "No rating"
            print(f"{i:3}. {rating_display:25} | {artist_title}")
            print(f"     {release_link}")
        if len(sorted_releases) > 20:
            print(f"\n... and {len(sorted_releases) - 20} more releases (see output.html for complete list)")


def main():
    """Main entry point."""
    # Get OAuth credentials from environment variables
    consumer_key = os.getenv('DISCOGS_CONSUMER_KEY')
    consumer_secret = os.getenv('DISCOGS_CONSUMER_SECRET')
    access_token = os.getenv('DISCOGS_ACCESS_TOKEN')
    access_token_secret = os.getenv('DISCOGS_ACCESS_TOKEN_SECRET')
    
    # Fallback to hardcoded credentials if env vars not set (for "digger" app)
    if not consumer_key:
        consumer_key = 'RIYMmadnWofJAiiIYikH'
        consumer_secret = 'hMKqpPjAGGGxuViMJFQEPdKtMgZQnGex'
    
    if not consumer_secret:
        consumer_secret = 'hMKqpPjAGGGxuViMJFQEPdKtMgZQnGex'
    
    if not consumer_key or not consumer_secret:
        print("Error: Discogs OAuth credentials not configured.")
        print("\nTo set it up:")
        print("1. Create a .env file in the project directory")
        print("2. Add your OAuth credentials:")
        print("   DISCOGS_CONSUMER_KEY=your_consumer_key")
        print("   DISCOGS_CONSUMER_SECRET=your_consumer_secret")
        print("   DISCOGS_ACCESS_TOKEN=your_access_token (optional)")
        print("   DISCOGS_ACCESS_TOKEN_SECRET=your_access_token_secret (optional)")
        print("\nOr get credentials from: https://www.discogs.com/settings/developers")
        sys.exit(1)
    
    # Get seller username from command line argument
    if len(sys.argv) < 2:
        print("Usage: python discogs_seller_releases.py <seller_username> [output_file]")
        print("\nExample:")
        print("  python discogs_seller_releases.py vinylseller")
        print("  python discogs_seller_releases.py vinylseller best_releases.html")
        sys.exit(1)
    
    seller_username = sys.argv[1]
    output_file = sys.argv[2] if len(sys.argv) > 2 else 'output.html'
    
    # Create and run the script
    client = DiscogsSellerReleases(
        consumer_key=consumer_key,
        consumer_secret=consumer_secret,
        access_token=access_token,
        access_token_secret=access_token_secret
    )
    client.run(seller_username, output_file)


if __name__ == '__main__':
    main()

