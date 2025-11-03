#!/bin/bash
# Quick start script for local development

echo "🎵 Starting Discogs Best Rated Releases..."
echo ""

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

# Activate virtual environment
echo "Activating virtual environment..."
source venv/bin/activate

# Install dependencies
echo "Installing dependencies..."
pip install -q -r requirements.txt

# Create static directory if it doesn't exist
mkdir -p static

echo ""
echo "✅ Setup complete!"
echo ""
echo "🚀 Starting Flask server..."
echo "📱 Open your browser to: http://localhost:5000"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

# Run the app
python app.py

