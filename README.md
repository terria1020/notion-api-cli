# Notion API CLI

A compact command-line interface for interacting with the Notion API with environment-based credential handling and structured logging so it plays nicely inside automation workflows.

## Features

- Retrieve any page via ID or URL, including title, timestamps, properties, and optionally block/child content.
- Update page titles and properties (select, checkbox, multi_select, dates, numbers, relations, people, rich_text, etc.) with schema-aware shorthand parsing.
- Work with blocks: list, append, update, delete, and manipulate table blocks (create tables, fetch rows, and append/update rows).
- Browse workspace content: search root pages/databases, list database pages, and discover child pages.
- Manage comments: list, create, and reply to discussions on pages or specific blocks.
- Inspect databases and query rows with paging/auto-expand support.

## Setup

1. Create a Notion integration at https://www.notion.so/my-integrations and copy the internal integration token.
2. Share every page you plan to read or edit with that integration via the page’s *Share → Add connections* menu.
3. Install dependencies with `npm install`.
4. Copy `.env.example` to `.env` and add your token (see **Environment** below).

```bash
cp .env.example .env
# then edit .env to set NOTION_API_TOKEN=your_token_here
```

## Environment

- `NOTION_API_TOKEN` (required) – integration token from Notion.
- `LOG_LEVEL` (default `info`) – controls console/file logging (`debug` / `info` / `error`).
- `NODE_ENV` – affects logger verbosity (non-`production` runs in `debug` mode by default).

Logs are emitted to `logs/error.log` (errors only) and `logs/combined.log` (all levels) while JSON-friendly messages remain on `stdout`.

## Usage

Run the CLI via `node notion-api-cli.js [command] [options]`.

### Page Operations

- `--get-page <id-or-url>` – fetch page metadata and formatted properties.
- `--update-page <id-or-url>` – change the title and/or properties. Use `--title "New Title"` and `--properties '{"Status":"Done","Tags":["work","urgent"]}'`.

### Block Operations

- `--get-page-blocks <id-or-url>` – dump block hierarchy (limit with `--limit`).
- `--append-blocks <id-or-url> --blocks '<JSON>'` – add new blocks (paragraphs, headings, lists, to-dos, code, callouts, dividers).
- `--update-block <block-id>` – edit text (`--text`) or toggle checkboxes (`--checked true|false`).
- `--delete-block <block-id>` – remove a block.
- Table helpers: `--create-table`, `--get-table`, `--append-table-row`, `--update-table-row` with `--columns`, `--headers`, and `--cells` payloads matching the block’s layout.

### Database & Workspace Queries

- `--get-database <id-or-url>` – inspect database schema.
- `--query-database <id-or-url>` – list rows (`--limit`, `--auto-expand` to fetch blocks).
- `--list-database-pages <id-or-url>` – list rows with an optional `--limit`.
- `--search-roots` – search workspace roots, filter by type (`--type page|database|all`), and optionally include rows (`--include-db-rows`).
- `--find-child-pages <id-or-url>` – enumerate children with `--direct-only` or `--limit`.

### Comment Management

- `--list-comments <target>` – show recent comments on a page/block (`--limit`).
- `--create-comment <target> --comment "text"` – add a comment.
- `--reply-comment <discussion-id> --comment "text"` – reply to a specific discussion.

## Examples

```bash
node notion-api-cli.js --get-page 0d5af387f61183a5b4618142b86338a5
node notion-api-cli.js --update-page 0d5af387f61183a5b4618142b86338a5 --title "Weekly Notes" --properties '{"Status":"In Review","Tags":["sprint"]}'
node notion-api-cli.js --append-blocks 0d5af387f61183a5b4618142b86338a5 --blocks '[{"type":"paragraph","text":"Automated update"}]'
node notion-api-cli.js --create-comment 0d5af387f61183a5b4618142b86338a5 --comment "Please review"
node notion-api-cli.js --query-database https://www.notion.so/... --limit 5 --auto-expand
```

## Troubleshooting

- Ensure the integration token has access to every workspace or page you target.
- Page IDs accept both hyphenated and compact forms (UUID vs. 32 hex digits).
- Use JSON valid strings for properties, comments, and block payloads. Invalid JSON will be rejected with a descriptive error message.

