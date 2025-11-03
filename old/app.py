#!/usr/bin/env python3
"""
Flask backend API for Discogs Best Rated Releases.
Provides Server-Sent Events (SSE) for real-time progress updates.
"""

import os
import json
import time
import uuid
import threading
from flask import Flask, request, jsonify, Response, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv
from discogs_seller_releases import DiscogsSellerReleases, bayesian_rating
from database import (
    get_seller_data, save_seller_data, create_job, update_job, 
    get_job, get_active_job_for_seller, cleanup_old_jobs, add_release_to_seller, delete_seller_data
)
import traceback

# Load environment variables
load_dotenv()

app = Flask(__name__, static_folder='static', static_url_path='/static')
CORS(app)  # Enable CORS for development

# Get OAuth credentials from environment
CONSUMER_KEY = os.getenv('DISCOGS_CONSUMER_KEY', 'RIYMmadnWofJAiiIYikH')
CONSUMER_SECRET = os.getenv('DISCOGS_CONSUMER_SECRET', 'hMKqpPjAGGGxuViMJFQEPdKtMgZQnGex')
ACCESS_TOKEN = os.getenv('DISCOGS_ACCESS_TOKEN')
ACCESS_TOKEN_SECRET = os.getenv('DISCOGS_ACCESS_TOKEN_SECRET')

# Background job tracking
active_jobs = {}  # job_id -> thread


def process_seller_background(job_id: str, seller_username: str):
    """
    Process seller data in background thread.
    
    Args:
        job_id: Unique job ID
        seller_username: Seller username
    """
    try:
        update_job(job_id, status='processing', current_step='Initializing...')
        
        # Initialize client
        client = DiscogsSellerReleases(
            consumer_key=CONSUMER_KEY,
            consumer_secret=CONSUMER_SECRET,
            access_token=ACCESS_TOKEN,
            access_token_secret=ACCESS_TOKEN_SECRET
        )
        
        # Fetch inventory
        all_listings = []
        page = 1
        per_page = 100
        
        update_job(job_id, current_step='Fetching inventory...')
        
        while True:
            try:
                print(f"[Job {job_id}] Fetching inventory page {page}...")
                inventory = client.get_seller_inventory(seller_username, page=page, per_page=per_page)
                listings = inventory.get('listings', [])
                
                if not listings:
                    print(f"[Job {job_id}] No listings on page {page}, stopping")
                    break
                
                all_listings.extend(listings)
                print(f"[Job {job_id}] Got {len(listings)} listings, total: {len(all_listings)}")
                
                pagination = inventory.get('pagination', {})
                total_pages = pagination.get('pages', 1)
                update_job(job_id, progress=page, total=total_pages, 
                          current_step=f'Fetching inventory: Page {page} of {total_pages}')
                
                if page >= total_pages:
                    print(f"[Job {job_id}] Reached last page ({total_pages})")
                    break
                
                page += 1
            except Exception as e:
                print(f"[Job {job_id}] Error fetching inventory page {page}: {e}")
                import traceback
                traceback.print_exc()
                
                if "429" in str(e) or "Too Many Requests" in str(e):
                    print(f"[Job {job_id}] Rate limited, waiting 60 seconds...")
                    update_job(job_id, current_step='Rate limited, waiting 60 seconds...')
                    time.sleep(60)
                    continue
                else:
                    print(f"[Job {job_id}] Non-rate-limit error, stopping inventory fetch")
                    # Don't break completely, use what we have
                    if all_listings:
                        print(f"[Job {job_id}] Continuing with {len(all_listings)} listings fetched so far")
                        break
                    else:
                        raise
        
        if not all_listings:
            update_job(job_id, status='error', error_message='No listings found for this seller')
            return
        
        # Process releases - collect unique releases with their lowest price
        unique_releases = {}
        for listing in all_listings:
            release_info = listing.get('release', {})
            release_id = release_info.get('id')
            if release_id:
                price_info = listing.get('price', {})
                price = float(price_info.get('value', 0.0)) if price_info else 0.0
                
                if release_id not in unique_releases:
                    unique_releases[release_id] = {
                        'info': release_info,
                        'price': price
                    }
                else:
                    # Keep the lowest price
                    if price > 0 and (unique_releases[release_id]['price'] == 0 or price < unique_releases[release_id]['price']):
                        unique_releases[release_id]['price'] = price
        
        total_releases = len(unique_releases)
        update_job(job_id, total=total_releases, current_step=f'Fetching details for {total_releases} releases...')
        
        # Check for existing releases to enable resume
        existing_data = get_seller_data(seller_username, max_age_hours=24*365)
        existing_ids = set()
        if existing_data:
            existing_ids = {r['id'] for r in existing_data['releases']}
            print(f"[Job {job_id}] Found {len(existing_ids)} existing releases, will skip those")
        
        # Fetch full details and save incrementally
        processed = 0
        skipped = 0
        print(f"[Job {job_id}] Starting to process {total_releases} unique releases...")
        
        for release_id, release_dict in unique_releases.items():
            # Check if job was cancelled
            current_job = get_job(job_id)
            if current_job and current_job['status'] == 'cancelled':
                print(f"[Job {job_id}] Job was cancelled, stopping...")
                return
            
            # Skip if already processed (resume functionality)
            if release_id in existing_ids:
                skipped += 1
                processed += 1
                if processed % 50 == 0:
                    print(f"[Job {job_id}] Processed {processed}/{total_releases} releases ({skipped} skipped)")
                continue
            
            release_info = release_dict['info']
            price = release_dict['price']
            
            artist = release_info.get('artist', 'Unknown Artist')
            title = release_info.get('title', 'Unknown Title')
            artist_title = f"{artist} - {title}"
            
            try:
                # Get full release details
                details = client.get_release_details(release_id)
                
                if not details:
                    print(f"[Job {job_id}] Failed to get details for release {release_id}")
                    processed += 1
                    continue
                
                # Calculate bayesian score
                bayesian_score = bayesian_rating(details['avg_rating'], details['num_ratings'])
                
                # Search for YouTube video
                youtube_video_id = client.search_youtube_video(details['artist'], details['title'])
                
                # Prepare release data with all fields
                release_data = {
                    'id': release_id,
                    'artist_title': artist_title,
                    'artist': details['artist'],
                    'title': details['title'],
                    'label': details['label'],
                    'year': details['year'],
                    'genres': json.dumps(details['genres']) if details['genres'] else None,
                    'styles': json.dumps(details['styles']) if details['styles'] else None,
                    'bayesian_score': bayesian_score,
                    'avg_rating': details['avg_rating'],
                    'num_ratings': details['num_ratings'],
                    'price': price,
                    'have_count': details['have_count'],
                    'want_count': details['want_count'],
                    'youtube_video_id': youtube_video_id,
                    'video_urls': json.dumps(details.get('videos', [])) if details.get('videos') else None,
                    'url': f"https://www.discogs.com/release/{release_id}"
                }
                
                # Save each release immediately to database
                add_release_to_seller(seller_username, release_data)
                
                processed += 1
                if processed % 10 == 0 or processed == 1:
                    print(f"[Job {job_id}] Processed {processed}/{total_releases} releases")
                update_job(job_id, progress=processed, 
                          current_step=f'Processing: {processed} of {total_releases} releases')
            except Exception as e:
                print(f"[Job {job_id}] Error fetching details for release {release_id}: {e}")
                import traceback
                traceback.print_exc()
                processed += 1
                continue
        
        # Mark seller as complete
        current_data = get_seller_data(seller_username, max_age_hours=24*365)
        if current_data:
            save_seller_data(seller_username, current_data['releases'], status='complete')
        
        update_job(job_id, status='complete', progress=total_releases, 
                  current_step='Complete!')
        
    except Exception as e:
        print(f"Error in background job {job_id}: {e}")
        update_job(job_id, status='error', error_message=str(e))
    finally:
        # Remove from active jobs
        if job_id in active_jobs:
            del active_jobs[job_id]


@app.route('/')
def index():
    """Serve the main HTML page."""
    return send_from_directory('static', 'index.html')


@app.route('/style.css')
def serve_css():
    """Serve the CSS file."""
    return send_from_directory('static', 'style.css')


@app.route('/script.js')
def serve_js():
    """Serve the JavaScript file."""
    return send_from_directory('static', 'script.js')


@app.route('/api/seller/<seller_username>', methods=['GET'])
def get_seller(seller_username):
    """
    Get seller data. Returns cached data if available, otherwise starts a background job.
    
    Query params:
        - force_refresh: If 'true', force a refresh even if cached data exists
        - max_age_hours: Maximum age of cached data (default: 24)
    
    Returns:
        JSON with seller data and/or job status
    """
    force_refresh = request.args.get('force_refresh', 'false').lower() == 'true'
    max_age_hours = int(request.args.get('max_age_hours', 24))
    
    # Check for active job
    active_job = get_active_job_for_seller(seller_username)
    if active_job:
        return jsonify({
            'status': 'processing',
            'job': active_job,
            'cached_data': None
        })
    
    # Check for cached data
    if not force_refresh:
        cached_data = get_seller_data(seller_username, max_age_hours)
        if cached_data:
            return jsonify({
                'status': 'cached',
                'job': None,
                'data': cached_data
            })
    
    # Start new background job
    job_id = str(uuid.uuid4())
    create_job(job_id, seller_username)
    
    thread = threading.Thread(
        target=process_seller_background,
        args=(job_id, seller_username),
        daemon=True
    )
    thread.start()
    active_jobs[job_id] = thread
    
    return jsonify({
        'status': 'started',
        'job': get_job(job_id),
        'cached_data': None
    })


@app.route('/api/job/<job_id>', methods=['GET'])
def get_job_status(job_id):
    """
    Get job status and current progress.
    Also returns partial data if job is still processing.
    
    Returns:
        JSON with job details and current data
    """
    job = get_job(job_id)
    if not job:
        return jsonify({'error': 'Job not found'}), 404
    
    # Always return current data from database (even if job is still processing)
    data = get_seller_data(job['seller_username'], max_age_hours=24*365)  # Get any cached data
    
    return jsonify({
        'job': job,
        'data': data
    })


@app.route('/api/job/<job_id>/cancel', methods=['POST'])
def cancel_job(job_id):
    """
    Cancel a running job.
    
    Returns:
        JSON with cancellation status
    """
    job = get_job(job_id)
    if not job:
        return jsonify({'error': 'Job not found'}), 404
    
    if job['status'] in ('complete', 'error', 'cancelled'):
        return jsonify({'error': 'Job is not running'}), 400
    
    # Mark job as cancelled
    update_job(job_id, status='cancelled', error_message='Cancelled by user')
    
    # Note: The background thread will continue until it checks the status
    # but we mark it as cancelled so the frontend knows
    
    return jsonify({'status': 'cancelled', 'message': 'Job cancelled successfully'})


@app.route('/api/health')
def health():
    """Health check endpoint."""
    cleanup_old_jobs()  # Clean up old jobs on health check
    return jsonify({'status': 'ok'})


@app.route('/api/debug/jobs')
def debug_jobs():
    """Debug endpoint to see all active jobs and threads."""
    import sqlite3
    conn = sqlite3.connect('discogs_cache.db')
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    cursor.execute('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 10')
    jobs = [dict(row) for row in cursor.fetchall()]
    
    cursor.execute('SELECT * FROM sellers')
    sellers = [dict(row) for row in cursor.fetchall()]
    
    cursor.execute('SELECT COUNT(*) as count FROM releases')
    release_count = cursor.fetchone()['count']
    
    conn.close()
    
    return jsonify({
        'active_threads': list(active_jobs.keys()),
        'jobs': jobs,
        'sellers': sellers,
        'total_releases': release_count
    })


@app.route('/api/seller/<seller_username>/clear', methods=['POST'])
def clear_seller_cache(seller_username):
    """
    Clear all cached data for a seller and cancel any running job.
    """
    # If there's an active job, mark it cancelled
    active_job = get_active_job_for_seller(seller_username)
    if active_job:
        try:
            update_job(active_job['job_id'], status='cancelled', error_message='Cleared by user')
        except Exception:
            pass
    
    # Delete all seller data
    delete_seller_data(seller_username)
    
    return jsonify({'status': 'cleared'})


if __name__ == '__main__':
    # Create static directory if it doesn't exist
    os.makedirs('static', exist_ok=True)
    
    # Get port from environment variable (for deployment) or default to 5000
    port = int(os.environ.get('PORT', 5001))
    debug = os.environ.get('FLASK_ENV') != 'production'
    
    # Run the app
    app.run(host='0.0.0.0', port=port, debug=debug, threaded=True)

