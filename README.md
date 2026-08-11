# Notion API CLI

A compact command-line interface for interacting with the Notion API with environment-based credential handling and structured logging so it plays nicely inside automation workflows.

## Features

- Retrieve any page via ID or URL, including title, timestamps, properties, and optionally block/child content.
- Update page titles and properties (select, checkbox, multi_select, dates, numbers, relations, people, rich_text, etc.) with schema-aware shorthand parsing.
- Work with blocks: list, append, update, delete, and manipulate table blocks (create tables, fetch rows, and append/update rows).
- Browse workspace content: search root pages/databases, list database pages, and discover child pages.
- Manage comments: list, create, and reply to discussions on pages or specific blocks.
- Inspect databases and query rows with paging/auto-expand support, plus server-side filter, sort, and property projection.
- Token-efficient output: responses are compact JSON with empty fields stripped, since the main consumer is an automated agent whose context budget is the real constraint.

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

### Output Format

Output is **compact JSON on a single line**, with `null`, empty-string, and empty-array
fields removed. On a 50-row database query this cuts the response by ~71% versus
indented, unfiltered JSON — and by ~84% with `--no-ids`.

Slimming changes representation, never facts. Redundant wrappers are collapsed:
`{"start":"2026-08-11","end":null,"time_zone":null}` becomes `"2026-08-11"`, and
`{"type":"number","number":42}` becomes `42`. Values that carry meaning are always kept,
including `false` and `0`.

These global flags work with any command:

- `--pretty` – restore 2-space indented output.
- `--verbose-fields` – keep null/default fields and raw Notion property shapes.
- `--no-ids` – omit `id` and `url` from read-only output. Use for inspection only; you
  need the ids to follow up with `--update-block`, `--get-table`, and friends.

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
  Push the work to the server rather than fetching everything and filtering locally:
  - `--filter '<JSON>'` – Notion filter object, e.g. `'{"property":"Status","select":{"equals":"Done"}}'`.
  - `--sorts '<JSON>'` – Notion sort array, e.g. `'[{"property":"Due","direction":"ascending"}]'`.
  - `--properties Name,Status` – fetch only these columns. Unknown names are rejected with the
    available list rather than silently returning nothing.
- `--list-database-pages <id-or-url>` – list rows with an optional `--limit`.
- `--search-roots` – search workspace roots, filter by type (`--type page|database|all`), and optionally include rows (`--include-db-rows`). Each item in `matches` carries `isWorkspaceRoot`.
- `--find-child-pages <id-or-url>` – enumerate child pages and child databases.
  - `--direct-only` – no recursion.
  - `--max-depth <n>` – traversal depth cap (default `3`).
  - `--deep` – also descend *into* discovered child pages. Off by default, because a page's
    own subtree is usually a separate question from "what is directly under this page".
  - `--limit <n>` – cap results; the response sets `truncated: true` when it hits the cap.

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

# 서버사이드 필터 + 필요한 컬럼만
node notion-api-cli.js --query-database 0d5af387f61183a5b4618142b86338a5 \
  --filter '{"property":"Status","select":{"equals":"Done"}}' --properties Name,Status

# 대량 조회를 최소 토큰으로
node notion-api-cli.js --query-database 0d5af387f61183a5b4618142b86338a5 --limit 300 --no-ids

# 직속 자식만 얕게 훑기
node notion-api-cli.js --find-child-pages 0d5af387f61183a5b4618142b86338a5 --max-depth 1
```

## Troubleshooting

- Ensure the integration token has access to every workspace or page you target.
- Page IDs accept both hyphenated and compact forms (UUID vs. 32 hex digits).
- URLs are accepted from both `notion.so` and `app.notion.com`, with or without a workspace
  segment or title slug. A `?v=` view id is never mistaken for the page id, and when a link
  carries `?p=` (a page opened as a side peek from a database view) that page wins over the
  database in the path.
- Use JSON valid strings for properties, comments, and block payloads. Invalid JSON will be rejected with a descriptive error message.

