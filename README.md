# Notion API CLI

A simple CLI tool for interacting with Notion API, enabling safe integration for AI model use through environment-based credential management.

## Features

- **Get Page**: Retrieve Notion page content and properties
- **Update Page**: Modify page title and properties (select, checkbox, multi_select)

## Setup

### 1. Create Notion Integration

1. Go to [Notion Integrations](https://www.notion.so/my-integrations)
2. Click "Create new integration"
3. Name it and select capabilities needed
4. Copy the "Internal Integration Token"

### 2. Share Page with Integration

For each page you want to access:
1. Open the page
2. Click "..." (More options) → "Add connections"
3. Select your integration

### 3. Configure CLI

```bash
# Create .env file
cp .env.example .env

# Edit .env and add your token
# NOTION_API_TOKEN=your_token_here
```

### 4. Install Dependencies

```bash
npm install
```

## Usage

### Get Page

```bash
node notion-api-cli.js --get-page <page-id>
```

Returns JSON with:
- Page ID and URL
- Title
- Creation and modification timestamps
- All page properties

**Example:**
```bash
node notion-api-cli.js --get-page 123abc456def789
```

### Update Page

```bash
node notion-api-cli.js --update-page <page-id> --title "New Title" --properties '{"Status":"Done"}'
```

**Options:**
- `--title "Title"`: Set page title
- `--properties '{"key":"value"}'`: Update properties as JSON
  - String values → select property
  - Boolean values → checkbox property
  - Array values → multi_select property

**Examples:**
```bash
# Update title only
node notion-api-cli.js --update-page 123abc456def789 --title "Updated Title"

# Update with properties
node notion-api-cli.js --update-page 123abc456def789 --title "New Title" --properties '{"Status":"Done","Priority":"High"}'

# Checkbox and multi_select
node notion-api-cli.js --update-page 123abc456def789 --properties '{"IsCompleted":true,"Tags":["work","urgent"]}'
```

## Logging

Logs are written to:
- `logs/error.log`: Error-level logs only
- `logs/combined.log`: All logs

Set `LOG_LEVEL` in .env to control verbosity:
- `debug`: Detailed debug information
- `info`: General information (default)
- `error`: Errors only

## Notes

- Page IDs can include or exclude hyphens (both formats accepted)
- Properties must match existing page property types
- The integration must have access to the page you're trying to modify
