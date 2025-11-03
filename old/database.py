#!/usr/bin/env python3
"""
Database module for caching Discogs seller data and tracking jobs.
"""

import sqlite3
import json
from datetime import datetime, timedelta
from typing import List, Dict, Optional
import threading

DB_FILE = 'discogs_cache.db'
_local = threading.local()


def get_db():
    """Get thread-local database connection."""
    if not hasattr(_local, 'connection'):
        _local.connection = sqlite3.connect(DB_FILE, check_same_thread=False)
        _local.connection.row_factory = sqlite3.Row
    return _local.connection


def init_db():
    """Initialize the database schema."""
    conn = get_db()
    cursor = conn.cursor()
    
    # Sellers table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS sellers (
            username TEXT PRIMARY KEY,
            last_updated TIMESTAMP,
            total_releases INTEGER,
            status TEXT DEFAULT 'complete'
        )
    ''')
    
    # Releases table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS releases (
            id INTEGER PRIMARY KEY,
            seller_username TEXT,
            artist_title TEXT,
            artist TEXT,
            title TEXT,
            label TEXT,
            year INTEGER,
            genres TEXT,
            styles TEXT,
            avg_rating REAL,
            num_ratings INTEGER,
            bayesian_score REAL,
            price REAL,
            have_count INTEGER,
            want_count INTEGER,
            youtube_video_id TEXT,
            video_urls TEXT,
            url TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (seller_username) REFERENCES sellers(username)
        )
    ''')
    
    # Jobs table for tracking background processing
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS jobs (
            job_id TEXT PRIMARY KEY,
            seller_username TEXT,
            status TEXT DEFAULT 'pending',
            progress INTEGER DEFAULT 0,
            total INTEGER DEFAULT 0,
            current_step TEXT,
            error_message TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (seller_username) REFERENCES sellers(username)
        )
    ''')
    
    # Create indexes
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_releases_seller ON releases(seller_username)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_releases_bayesian ON releases(bayesian_score DESC)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)')
    
    conn.commit()


def get_seller_data(username: str, max_age_hours: int = 24) -> Optional[Dict]:
    """
    Get cached seller data if it exists and is recent enough.
    
    Args:
        username: Seller username
        max_age_hours: Maximum age of cached data in hours
        
    Returns:
        Dict with seller info and releases, or None if not cached/too old
    """
    conn = get_db()
    cursor = conn.cursor()
    
    # Check if seller exists and is recent
    cursor.execute('''
        SELECT username, last_updated, total_releases, status
        FROM sellers
        WHERE username = ? AND last_updated > datetime('now', '-' || ? || ' hours')
    ''', (username, max_age_hours))
    
    seller = cursor.fetchone()
    if not seller:
        return None
    
    # Get releases
    cursor.execute('''
        SELECT id, artist_title, artist, title, label, year, genres, styles,
               avg_rating, num_ratings, bayesian_score, price, have_count, 
               want_count, youtube_video_id, video_urls, url
        FROM releases
        WHERE seller_username = ?
        ORDER BY bayesian_score DESC
    ''', (username,))
    
    releases = []
    for row in cursor.fetchall():
        releases.append({
            'id': row['id'],
            'artist_title': row['artist_title'],
            'artist': row['artist'],
            'title': row['title'],
            'label': row['label'],
            'year': row['year'],
            'genres': row['genres'],
            'styles': row['styles'],
            'avg_rating': row['avg_rating'],
            'num_ratings': row['num_ratings'],
            'bayesian_score': row['bayesian_score'],
            'price': row['price'],
            'have_count': row['have_count'],
            'want_count': row['want_count'],
            'youtube_video_id': row['youtube_video_id'],
            'video_urls': row['video_urls'],
            'url': row['url']
        })
    
    return {
        'username': seller['username'],
        'last_updated': seller['last_updated'],
        'total_releases': seller['total_releases'],
        'status': seller['status'],
        'releases': releases
    }


def save_seller_data(username: str, releases: List[Dict], status: str = 'complete'):
    """
    Save seller data and releases to database.
    
    Args:
        username: Seller username
        releases: List of release dicts
        status: Seller status ('processing' or 'complete')
    """
    conn = get_db()
    cursor = conn.cursor()
    
    # Insert or update seller
    cursor.execute('''
        INSERT INTO sellers (username, last_updated, total_releases, status)
        VALUES (?, datetime('now'), ?, ?)
        ON CONFLICT(username) DO UPDATE SET
            last_updated = datetime('now'),
            total_releases = excluded.total_releases,
            status = excluded.status
    ''', (username, len(releases), status))
    
    # Delete old releases for this seller
    cursor.execute('DELETE FROM releases WHERE seller_username = ?', (username,))
    
    # Insert new releases
    for release in releases:
        cursor.execute('''
            INSERT INTO releases (id, seller_username, artist_title, artist, title, label, year,
                                genres, styles, avg_rating, num_ratings, bayesian_score, 
                                price, have_count, want_count, youtube_video_id, video_urls, url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            release['id'],
            username,
            release['artist_title'],
            release.get('artist'),
            release.get('title'),
            release.get('label'),
            release.get('year'),
            release.get('genres'),
            release.get('styles'),
            release['avg_rating'],
            release['num_ratings'],
            release['bayesian_score'],
            release.get('price'),
            release.get('have_count'),
            release.get('want_count'),
            release.get('youtube_video_id'),
            release.get('video_urls'),
            release['url']
        ))
    
    conn.commit()


def add_release_to_seller(username: str, release: Dict):
    """
    Add a single release to seller's data (for incremental updates).
    
    Args:
        username: Seller username
        release: Release dict
    """
    conn = get_db()
    cursor = conn.cursor()
    
    # Ensure seller exists
    cursor.execute('''
        INSERT OR IGNORE INTO sellers (username, last_updated, total_releases, status)
        VALUES (?, datetime('now'), 0, 'processing')
    ''', (username,))
    
    # Insert or replace release
    cursor.execute('''
        INSERT OR REPLACE INTO releases (id, seller_username, artist_title, artist, title, label, year,
                                        genres, styles, avg_rating, num_ratings, bayesian_score,
                                        price, have_count, want_count, youtube_video_id, video_urls, url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (
        release['id'],
        username,
        release['artist_title'],
        release.get('artist'),
        release.get('title'),
        release.get('label'),
        release.get('year'),
        release.get('genres'),
        release.get('styles'),
        release['avg_rating'],
        release['num_ratings'],
        release['bayesian_score'],
        release.get('price'),
        release.get('have_count'),
        release.get('want_count'),
        release.get('youtube_video_id'),
        release.get('video_urls'),
        release['url']
    ))
    
    # Update seller's total_releases count
    cursor.execute('''
        UPDATE sellers 
        SET total_releases = (SELECT COUNT(*) FROM releases WHERE seller_username = ?),
            last_updated = datetime('now')
        WHERE username = ?
    ''', (username, username))
    
    conn.commit()


def create_job(job_id: str, seller_username: str) -> str:
    """
    Create a new job for processing a seller.
    
    Args:
        job_id: Unique job ID
        seller_username: Seller username
        
    Returns:
        Job ID
    """
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute('''
        INSERT INTO jobs (job_id, seller_username, status, current_step)
        VALUES (?, ?, 'pending', 'Initializing...')
        ON CONFLICT(job_id) DO UPDATE SET
            status = 'pending',
            updated_at = datetime('now')
    ''', (job_id, seller_username))
    
    conn.commit()
    return job_id


def update_job(job_id: str, status: str = None, progress: int = None, 
               total: int = None, current_step: str = None, error_message: str = None):
    """
    Update job status and progress.
    
    Args:
        job_id: Job ID
        status: Job status (pending, processing, complete, error)
        progress: Current progress
        total: Total items
        current_step: Description of current step
        error_message: Error message if failed
    """
    conn = get_db()
    cursor = conn.cursor()
    
    updates = ['updated_at = datetime(\'now\')']
    params = []
    
    if status:
        updates.append('status = ?')
        params.append(status)
    if progress is not None:
        updates.append('progress = ?')
        params.append(progress)
    if total is not None:
        updates.append('total = ?')
        params.append(total)
    if current_step:
        updates.append('current_step = ?')
        params.append(current_step)
    if error_message:
        updates.append('error_message = ?')
        params.append(error_message)
    
    params.append(job_id)
    
    cursor.execute(f'''
        UPDATE jobs
        SET {', '.join(updates)}
        WHERE job_id = ?
    ''', params)
    
    conn.commit()


def get_job(job_id: str) -> Optional[Dict]:
    """
    Get job status and details.
    
    Args:
        job_id: Job ID
        
    Returns:
        Dict with job details or None
    """
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute('''
        SELECT job_id, seller_username, status, progress, total, current_step, 
               error_message, created_at, updated_at
        FROM jobs
        WHERE job_id = ?
    ''', (job_id,))
    
    row = cursor.fetchone()
    if not row:
        return None
    
    return {
        'job_id': row['job_id'],
        'seller_username': row['seller_username'],
        'status': row['status'],
        'progress': row['progress'],
        'total': row['total'],
        'current_step': row['current_step'],
        'error_message': row['error_message'],
        'created_at': row['created_at'],
        'updated_at': row['updated_at']
    }


def get_active_job_for_seller(seller_username: str) -> Optional[Dict]:
    """
    Get active job for a seller if one exists.
    
    Args:
        seller_username: Seller username
        
    Returns:
        Job dict or None
    """
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute('''
        SELECT job_id, seller_username, status, progress, total, current_step,
               error_message, created_at, updated_at
        FROM jobs
        WHERE seller_username = ? AND status IN ('pending', 'processing')
        ORDER BY created_at DESC
        LIMIT 1
    ''', (seller_username,))
    
    row = cursor.fetchone()
    if not row:
        return None
    
    return {
        'job_id': row['job_id'],
        'seller_username': row['seller_username'],
        'status': row['status'],
        'progress': row['progress'],
        'total': row['total'],
        'current_step': row['current_step'],
        'error_message': row['error_message'],
        'created_at': row['created_at'],
        'updated_at': row['updated_at']
    }


def cleanup_old_jobs(days: int = 7):
    """
    Clean up old completed/failed jobs.
    
    Args:
        days: Delete jobs older than this many days
    """
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute('''
        DELETE FROM jobs
        WHERE status IN ('complete', 'error') 
        AND created_at < datetime('now', '-' || ? || ' days')
    ''', (days,))
    
    conn.commit()


# Initialize database on import
init_db()


def delete_seller_data(username: str):
    """
    Permanently delete a seller and all associated releases and jobs.
    """
    conn = get_db()
    cursor = conn.cursor()
    
    # Delete releases first due to FK
    cursor.execute('DELETE FROM releases WHERE seller_username = ?', (username,))
    # Delete jobs for this seller
    cursor.execute('DELETE FROM jobs WHERE seller_username = ?', (username,))
    # Delete seller record
    cursor.execute('DELETE FROM sellers WHERE username = ?', (username,))
    
    conn.commit()

