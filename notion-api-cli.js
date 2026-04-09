#!/usr/bin/env node

/**
 * notion-api-cli.js
 *
 * A CLI tool for interacting with Notion API
 * - Retrieve page content
 * - Modify page properties
 *
 * Notion API token is managed via environment variable (NOTION_API_TOKEN)
 * Loaded from .env file or system environment.
 *
 * Usage:
 *   node notion-api-cli.js --help
 *   node notion-api-cli.js --get-page <page-id>
 *   node notion-api-cli.js --update-page <page-id> --title "New Title"
 *   node notion-api-cli.js --update-page <page-id> --title "New Title" --properties '{"Status":"Done"}'
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('@notionhq/client');
const winston = require('winston');

// Load environment variables from .env file
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

// ─── Constants ────────────────────────────────────────────────────────────────

const SCRIPT_DIR = __dirname;
const LOG_DIR = path.join(process.cwd(), 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

// ─── Logger ────────────────────────────────────────────────────────────────────
// CLI의 결과물은 stdout(console.log / process.stdout.write)에 내보내야
// JSON 출력이 깨지지 않습니다. 로깅은 stderr + logs/*.log(파일)로 남깁니다.
const APP_NAME = 'notion-api-cli';

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack }) => {
    if (stack) {
      return `${timestamp} [${level.toUpperCase()}]: ${message}\n${stack}`;
    }
    return `${timestamp} [${level.toUpperCase()}]: ${message}`;
  })
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        logFormat
      ),
      stream: process.stderr,
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.level = 'debug';
}

let _exiting = false;
const CLI_EXIT = Symbol('CLI_EXIT');

function exitCli(code) {
  if (_exiting) return;
  _exiting = true;
  logger.end?.() || logger.close?.();
  setTimeout(() => process.exit(code), 50);
}

function die(msg) {
  logger.error(msg);
  exitCli(1);
  throw CLI_EXIT;
}

// ─── Helper Functions ────────────────────────────────────────────────────────

function extractPageIdFromUrl(input) {
  // Try to parse as Notion URL
  // https://www.notion.so/{workspace}/{slug}-{page-id}?v=...
  // https://www.notion.so/{workspace}/{page-id}?v=...
  // https://notion.so/{workspace}/{slug}-{page-id}?v=...
  const urlMatch = input.match(/notion\.so\/(?:[^/]+\/)?(?:[^/?#]+-)?([0-9a-f]{32})(?:[/?#]|$)/i);
  if (urlMatch) {
    return urlMatch[1].toLowerCase();
  }

  // If not a URL, return as-is for ID validation
  return input.toLowerCase().replace(/-/g, '');
}

function validateNotionId(id) {
  // Notion IDs can be with or without hyphens
  // Format: 32 hex characters, optionally grouped with hyphens
  const cleanId = id.toLowerCase().replace(/-/g, '');
  return /^[0-9a-f]{32}$/.test(cleanId);
}

function normalizeNotionId(id) {
  // Remove hyphens for API calls
  return id.toLowerCase().replace(/-/g, '');
}

function formatPropertyValue(prop) {
  if (!prop || !prop.type) {
    return null;
  }

  switch (prop.type) {
    case 'title':
      return prop.title.map(t => t.plain_text).join('');
    case 'rich_text':
      return prop.rich_text.map(t => t.plain_text).join('');
    case 'checkbox':
      return prop.checkbox;
    case 'select':
      return prop.select?.name || null;
    case 'multi_select':
      return prop.multi_select.map(s => s.name);
    case 'status':
      return prop.status?.name || null;
    case 'date':
      return prop.date || null;
    case 'url':
      return prop.url || null;
    case 'email':
      return prop.email || null;
    case 'number':
      return prop.number;
    case 'people':
      return prop.people.map(p => ({
        id: p.id,
        name: p.name || null,
        type: p.type || 'person',
      }));
    case 'relation':
      return prop.relation.map(r => r.id);
    case 'formula':
      return prop.formula || null;
    case 'created_time':
      return prop.created_time || null;
    default:
      return `[${prop.type}]`;
  }
}

function formatPageOutput(page) {
  return {
    id: page.id,
    url: page.url,
    title: page.properties.Title?.title?.[0]?.plain_text || '(Untitled)',
    createdTime: page.created_time,
    lastEditedTime: page.last_edited_time,
    properties: Object.entries(page.properties).reduce((acc, [key, prop]) => {
      acc[key] = formatPropertyValue(prop);
      return acc;
    }, {}),
  };
}

function formatDatabaseOutput(database) {
  return {
    id: database.id,
    url: database.url,
    title: database.title?.[0]?.plain_text || '(Untitled)',
    createdTime: database.created_time,
    lastEditedTime: database.last_edited_time,
    properties: Object.entries(database.properties).reduce((acc, [key, prop]) => {
      acc[key] = {
        type: prop.type,
        config: prop[prop.type] || {},
      };
      return acc;
    }, {}),
  };
}

function formatQueryResults(response, includeBlocks = false) {
  return {
    results: response.results.map(item => {
      const props = {};
      Object.entries(item.properties).forEach(([key, prop]) => {
        props[key] = formatPropertyValue(prop);
      });

      const result = {
        id: item.id,
        url: item.url,
        properties: props,
      };

      if (includeBlocks && item._blocks) {
        result.blocks = item._blocks;
      }

      return result;
    }),
    hasMore: response.has_more,
    nextCursor: response.next_cursor,
  };
}

function formatBlockContent(block) {
  const type = block.type;
  const content = block[type];

  switch (type) {
    case 'paragraph':
      return {
        id: block.id,
        type: 'paragraph',
        text: content.rich_text.map(t => t.plain_text).join(''),
        color: content.color,
      };
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
      return {
        id: block.id,
        type,
        text: content.rich_text.map(t => t.plain_text).join(''),
        color: content.color,
      };
    case 'bulleted_list_item':
      return {
        id: block.id,
        type: 'bulleted_list_item',
        text: content.rich_text.map(t => t.plain_text).join(''),
      };
    case 'numbered_list_item':
      return {
        id: block.id,
        type: 'numbered_list_item',
        text: content.rich_text.map(t => t.plain_text).join(''),
      };
    case 'to_do':
      return {
        id: block.id,
        type: 'to_do',
        text: content.rich_text.map(t => t.plain_text).join(''),
        checked: content.checked,
      };
    case 'quote':
      return {
        id: block.id,
        type: 'quote',
        text: content.rich_text.map(t => t.plain_text).join(''),
      };
    case 'callout':
      return {
        id: block.id,
        type: 'callout',
        text: content.rich_text.map(t => t.plain_text).join(''),
        icon: content.icon,
      };
    case 'code':
      return {
        id: block.id,
        type: 'code',
        text: content.rich_text.map(t => t.plain_text).join(''),
        language: content.language,
      };
    case 'divider':
      return { id: block.id, type: 'divider' };
    case 'image':
      return {
        id: block.id,
        type: 'image',
        url: content.file?.url || content.external?.url,
      };
    case 'table':
      return {
        id: block.id,
        type: 'table',
        hasColumnHeader: content.has_column_header,
        hasRowHeader: content.has_row_header,
        cellsInfo: '(use --get-page-blocks for full table content)',
      };
    case 'bookmark':
      return {
        id: block.id,
        type: 'bookmark',
        url: content.url,
      };
    default:
      return {
        id: block.id,
        type,
        note: `[${type} block - not fully supported]`,
      };
  }
}

function buildBlockObject(blockDef) {
  const { type, text, checked, language, icon, color } = blockDef;
  const blockObj = {};

  switch (type) {
    case 'paragraph':
      blockObj.object = 'block';
      blockObj.type = 'paragraph';
      blockObj.paragraph = {
        rich_text: text ? [{ type: 'text', text: { content: text } }] : [],
        color: color || 'default',
      };
      return blockObj;

    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
      blockObj.object = 'block';
      blockObj.type = type;
      blockObj[type] = {
        rich_text: text ? [{ type: 'text', text: { content: text } }] : [],
        color: color || 'default',
      };
      return blockObj;

    case 'bulleted_list_item':
      blockObj.object = 'block';
      blockObj.type = 'bulleted_list_item';
      blockObj.bulleted_list_item = {
        rich_text: text ? [{ type: 'text', text: { content: text } }] : [],
      };
      return blockObj;

    case 'numbered_list_item':
      blockObj.object = 'block';
      blockObj.type = 'numbered_list_item';
      blockObj.numbered_list_item = {
        rich_text: text ? [{ type: 'text', text: { content: text } }] : [],
      };
      return blockObj;

    case 'to_do':
      blockObj.object = 'block';
      blockObj.type = 'to_do';
      blockObj.to_do = {
        rich_text: text ? [{ type: 'text', text: { content: text } }] : [],
        checked: checked || false,
      };
      return blockObj;

    case 'quote':
      blockObj.object = 'block';
      blockObj.type = 'quote';
      blockObj.quote = {
        rich_text: text ? [{ type: 'text', text: { content: text } }] : [],
      };
      return blockObj;

    case 'callout':
      blockObj.object = 'block';
      blockObj.type = 'callout';
      blockObj.callout = {
        rich_text: text ? [{ type: 'text', text: { content: text } }] : [],
        icon: icon ? { type: 'emoji', emoji: icon } : { type: 'emoji', emoji: '💡' },
      };
      return blockObj;

    case 'code':
      blockObj.object = 'block';
      blockObj.type = 'code';
      blockObj.code = {
        rich_text: text ? [{ type: 'text', text: { content: text } }] : [],
        language: language || 'plain text',
      };
      return blockObj;

    case 'divider':
      blockObj.object = 'block';
      blockObj.type = 'divider';
      blockObj.divider = {};
      return blockObj;

    default:
      die(`Unsupported block type: ${type}`);
  }
}

function buildTableRowCells(cellsInput) {
  if (!Array.isArray(cellsInput)) {
    die('--cells must be a JSON array of strings (one element per column)');
  }

  return cellsInput.map(cell => {
    if (cell === null || cell === undefined || cell === '') {
      return [];
    }

    if (typeof cell === 'string') {
      return [{ type: 'text', text: { content: cell } }];
    }

    die('--cells array can only contain strings or null/empty values');
  });
}

function parseJsonOption(jsonString, optionName) {
  if (!jsonString) {
    die(`--${optionName} requires a JSON string`);
  }

  try {
    return JSON.parse(jsonString);
  } catch (err) {
    die(`Invalid JSON for --${optionName}: ${err.message}`);
  }
}

function toRichText(content) {
  if (content === null || content === undefined) {
    return [];
  }
  return [{ type: 'text', text: { content: String(content) } }];
}

function toNotionObjectRef(idOrUrl, label) {
  if (typeof idOrUrl !== 'string') {
    die(`${label} values must be strings (Notion ID or URL)`);
  }

  const extracted = extractPageIdFromUrl(idOrUrl);
  if (!validateNotionId(extracted)) {
    die(`Invalid ${label} ID or URL: ${idOrUrl}`);
  }

  return { id: normalizeNotionId(extracted) };
}

function buildTypedPropertyPayload(propertyName, type, value) {
  switch (type) {
    case 'select':
      if (typeof value !== 'string') {
        die(`Property ${propertyName}: select requires a string`);
      }
      return { select: { name: value } };
    case 'checkbox':
      if (typeof value !== 'boolean') {
        die(`Property ${propertyName}: checkbox requires true/false`);
      }
      return { checkbox: value };
    case 'multi_select':
      if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) {
        die(`Property ${propertyName}: multi_select requires string array`);
      }
      return { multi_select: value.map(v => ({ name: v })) };
    case 'status':
      if (typeof value !== 'string') {
        die(`Property ${propertyName}: status requires a string`);
      }
      return { status: { name: value } };
    case 'url':
      if (value !== null && typeof value !== 'string') {
        die(`Property ${propertyName}: url requires a string or null`);
      }
      return { url: value };
    case 'rich_text':
    case 'text':
      if (value !== null && typeof value !== 'string') {
        die(`Property ${propertyName}: text requires a string or null`);
      }
      return { rich_text: toRichText(value) };
    case 'number':
      if (value !== null && typeof value !== 'number') {
        die(`Property ${propertyName}: number requires a number or null`);
      }
      return { number: value };
    case 'date':
      if (typeof value === 'string') {
        return { date: { start: value } };
      }
      if (value && typeof value === 'object') {
        if (!value.start || typeof value.start !== 'string') {
          die(`Property ${propertyName}: date object requires start`);
        }
        return {
          date: {
            start: value.start,
            end: value.end || null,
            time_zone: value.time_zone || null,
          },
        };
      }
      if (value === null) {
        return { date: null };
      }
      die(`Property ${propertyName}: date requires string, object, or null`);
      break;
    case 'people':
      if (!Array.isArray(value)) {
        die(`Property ${propertyName}: people requires an array`);
      }
      return { people: value.map(v => toNotionObjectRef(v, `people of ${propertyName}`)) };
    case 'email':
      if (value !== null && typeof value !== 'string') {
        die(`Property ${propertyName}: email requires a string or null`);
      }
      return { email: value };
    case 'relation':
      if (!Array.isArray(value)) {
        die(`Property ${propertyName}: relation requires an array`);
      }
      return { relation: value.map(v => toNotionObjectRef(v, `relation of ${propertyName}`)) };
    case 'formula':
    case 'created_time':
      die(`Property ${propertyName}: ${type} is read-only and cannot be updated`);
      break;
    default:
      die(`Property ${propertyName}: unsupported type "${type}"`);
  }
}

function buildPagePropertyPayload(propertyName, value, existingType = null) {
  if (value === null || value === undefined) {
    die(`Property ${propertyName}: value cannot be null/undefined without explicit type`);
  }

  // If we know the actual schema type, use it first for shorthand values.
  if (existingType) {
    if (typeof value === 'string') {
      if (existingType === 'url' || existingType === 'email' || existingType === 'status' || existingType === 'select' || existingType === 'rich_text') {
        return buildTypedPropertyPayload(propertyName, existingType === 'rich_text' ? 'text' : existingType, value);
      }
      if (existingType === 'date') {
        return buildTypedPropertyPayload(propertyName, 'date', value);
      }
    }
    if (typeof value === 'boolean' && existingType === 'checkbox') {
      return buildTypedPropertyPayload(propertyName, 'checkbox', value);
    }
    if (typeof value === 'number' && existingType === 'number') {
      return buildTypedPropertyPayload(propertyName, 'number', value);
    }
    if (Array.isArray(value)) {
      if (existingType === 'multi_select') {
        return buildTypedPropertyPayload(propertyName, 'multi_select', value);
      }
      if (existingType === 'people') {
        return buildTypedPropertyPayload(propertyName, 'people', value);
      }
      if (existingType === 'relation') {
        return buildTypedPropertyPayload(propertyName, 'relation', value);
      }
    }
  }

  // Backward compatibility fallback when schema type is unknown.
  if (typeof value === 'string') {
    return { select: { name: value } };
  }
  if (typeof value === 'boolean') {
    return { checkbox: value };
  }
  if (typeof value === 'number') {
    return { number: value };
  }
  if (Array.isArray(value)) {
    if (!value.every(v => typeof v === 'string')) {
      die(`Property ${propertyName}: array shorthand supports string array only`);
    }
    return { multi_select: value.map(v => ({ name: v })) };
  }

  if (typeof value !== 'object') {
    die(`Property ${propertyName}: unsupported value type`);
  }

  if (Object.prototype.hasOwnProperty.call(value, 'type')) {
    if (typeof value.type !== 'string') {
      die(`Property ${propertyName}: type must be a string`);
    }
    return buildTypedPropertyPayload(propertyName, value.type, value.value);
  }

  // Object shorthand forms: {url:"..."}, {text:"..."}, {status:"Done"}, ...
  const aliases = [
    ['select', 'select'],
    ['checkbox', 'checkbox'],
    ['multi_select', 'multi_select'],
    ['status', 'status'],
    ['url', 'url'],
    ['text', 'text'],
    ['rich_text', 'rich_text'],
    ['number', 'number'],
    ['date', 'date'],
    ['people', 'people'],
    ['email', 'email'],
    ['relation', 'relation'],
    ['formula', 'formula'],
    ['created_time', 'created_time'],
  ];

  for (const [key, type] of aliases) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      return buildTypedPropertyPayload(propertyName, type, value[key]);
    }
  }

  die(`Property ${propertyName}: unsupported object format`);
}

function getPlainTextFromRichText(richText = []) {
  if (!Array.isArray(richText)) {
    return '';
  }
  return richText.map(item => item.plain_text || '').join('');
}

function extractTitleFromPage(page) {
  if (!page || !page.properties) {
    return '(Untitled)';
  }

  for (const prop of Object.values(page.properties)) {
    if (prop && prop.type === 'title') {
      const text = getPlainTextFromRichText(prop.title);
      return text || '(Untitled)';
    }
  }

  return '(Untitled)';
}

function extractTitleFromSearchItem(item) {
  if (!item) {
    return '(Untitled)';
  }

  if (item.object === 'page') {
    return extractTitleFromPage(item);
  }

  if (item.object === 'database') {
    const text = getPlainTextFromRichText(item.title);
    return text || '(Untitled)';
  }

  return '(Untitled)';
}

function parseParentInfo(item) {
  const parent = item?.parent || {};
  const parentType = parent.type || 'unknown';
  const parentId = parentType === 'workspace' ? null : (parent[parentType] || null);
  const isWorkspaceRoot = parentType === 'workspace';

  return {
    parentType,
    parentId,
    isWorkspaceRoot,
  };
}

function normalizeTableRowsInput(rowsInput, columnCount, optionName) {
  if (!Array.isArray(rowsInput)) {
    die(`--${optionName} must be a JSON array of rows`);
  }

  return rowsInput.map((row, rowIndex) => {
    if (!Array.isArray(row)) {
      die(`--${optionName}[${rowIndex}] must be an array`);
    }
    if (row.length !== columnCount) {
      die(`--${optionName}[${rowIndex}] must have exactly ${columnCount} cells`);
    }
    return buildTableRowCells(row);
  });
}

function formatSearchItem(item) {
  const parentInfo = parseParentInfo(item);
  return {
    object: item.object,
    id: item.id,
    url: item.url,
    title: extractTitleFromSearchItem(item),
    parentType: parentInfo.parentType,
    parentId: parentInfo.parentId,
    isWorkspaceRoot: parentInfo.isWorkspaceRoot,
  };
}

function normalizePageSummary(page) {
  const parentInfo = parseParentInfo(page);
  return {
    id: page.id,
    url: page.url,
    title: extractTitleFromPage(page),
    parentType: parentInfo.parentType,
    parentId: parentInfo.parentId,
    createdTime: page.created_time,
    lastEditedTime: page.last_edited_time,
  };
}

// ─── Notion API Initialization ─────────────────────────────────────────────────

function initializeNotionClient() {
  const token = process.env.NOTION_API_TOKEN;

  if (!token) {
    die('NOTION_API_TOKEN environment variable not set. Create a .env file and set NOTION_API_TOKEN.');
  }

  logger.debug(`Initializing Notion client with token: ${token.substring(0, 10)}...`);
  return new Client({ auth: token });
}

// ─── Command Handlers ───────────────────────────────────────────────────────

async function getPage(notion, pageIdOrUrl) {
  const pageId = extractPageIdFromUrl(pageIdOrUrl);

  if (!validateNotionId(pageId)) {
    die(`Invalid Notion page ID or URL: ${pageIdOrUrl}`);
  }

  try {
    logger.info(`Fetching page: ${pageId}`);
    const normalizedId = normalizeNotionId(pageId);
    const page = await notion.pages.retrieve({ page_id: normalizedId });

    logger.debug(`Successfully retrieved page: ${page.id}`);
    const formatted = formatPageOutput(page);
    console.log(JSON.stringify(formatted, null, 2));
  } catch (err) {
    if (err.status === 404) {
      die(`Page not found: ${pageId}`);
    } else if (err.status === 401) {
      die('Unauthorized: Invalid or expired NOTION_API_TOKEN');
    } else {
      die(`Failed to retrieve page: ${err.message}`);
    }
  }
}

async function updatePage(notion, pageIdOrUrl, title, propertiesJson) {
  const pageId = extractPageIdFromUrl(pageIdOrUrl);

  if (!validateNotionId(pageId)) {
    die(`Invalid Notion page ID or URL: ${pageIdOrUrl}`);
  }

  try {
    logger.info(`Updating page: ${pageId}`);
    const normalizedId = normalizeNotionId(pageId);
    const currentPage = await notion.pages.retrieve({ page_id: normalizedId });
    const currentPropertyTypes = Object.entries(currentPage.properties || {}).reduce((acc, [name, prop]) => {
      acc[name] = prop.type;
      return acc;
    }, {});

    // Build properties object
    const properties = {};

    // Add title if provided
    if (title) {
      const titlePropertyName = Object.entries(currentPage.properties || {}).find(([, prop]) => prop.type === 'title')?.[0] || 'Title';
      properties[titlePropertyName] = {
        title: [{ text: { content: title } }],
      };
      logger.debug(`Setting title: ${title}`);
    }

    // Parse and add additional properties if provided
    if (propertiesJson) {
      let additionalProps;
      try {
        additionalProps = JSON.parse(propertiesJson);
      } catch (err) {
        die(`Invalid JSON for properties: ${err.message}`);
      }

      // Add additional properties
      for (const [key, value] of Object.entries(additionalProps)) {
        if (currentPropertyTypes[key] === 'title') {
          properties[key] = {
            title: toRichText(value),
          };
          logger.debug(`Prepared title update for ${key}`);
          continue;
        }
        properties[key] = buildPagePropertyPayload(key, value, currentPropertyTypes[key] || null);
        logger.debug(`Prepared property update for ${key}`);
      }
    }

    if (Object.keys(properties).length === 0) {
      die('No properties to update. Provide --title or --properties');
    }

    const updatedPage = await notion.pages.update({
      page_id: normalizedId,
      properties,
    });

    logger.debug(`Successfully updated page: ${updatedPage.id}`);
    const formatted = formatPageOutput(updatedPage);
    console.log(JSON.stringify(formatted, null, 2));
  } catch (err) {
    if (err.status === 404) {
      die(`Page not found: ${pageId}`);
    } else if (err.status === 401) {
      die('Unauthorized: Invalid or expired NOTION_API_TOKEN');
    } else {
      die(`Failed to update page: ${err.message}`);
    }
  }
}

async function getDatabase(notion, databaseIdOrUrl) {
  const databaseId = extractPageIdFromUrl(databaseIdOrUrl);

  if (!validateNotionId(databaseId)) {
    die(`Invalid Notion database ID or URL: ${databaseIdOrUrl}`);
  }

  try {
    logger.info(`Fetching database: ${databaseId}`);
    const normalizedId = normalizeNotionId(databaseId);
    const database = await notion.databases.retrieve({ database_id: normalizedId });

    logger.debug(`Successfully retrieved database: ${database.id}`);
    const formatted = formatDatabaseOutput(database);
    console.log(JSON.stringify(formatted, null, 2));
  } catch (err) {
    if (err.status === 404) {
      die(`Database not found: ${databaseId}`);
    } else if (err.status === 401) {
      die('Unauthorized: Invalid or expired NOTION_API_TOKEN');
    } else {
      die(`Failed to retrieve database: ${err.message}`);
    }
  }
}

async function queryDatabase(notion, databaseIdOrUrl, limit = 10, autoExpand = false) {
  const databaseId = extractPageIdFromUrl(databaseIdOrUrl);

  if (!validateNotionId(databaseId)) {
    die(`Invalid Notion database ID or URL: ${databaseIdOrUrl}`);
  }

  try {
    logger.info(`Querying database: ${databaseId} (limit: ${limit})`);
    const normalizedId = normalizeNotionId(databaseId);
    const response = await notion.databases.query({
      database_id: normalizedId,
      page_size: Math.min(limit, 100),
    });

    logger.debug(`Successfully queried database: ${response.results.length} items`);

    if (autoExpand) {
      logger.info(`Auto-expanding ${response.results.length} items...`);
      for (let i = 0; i < response.results.length; i++) {
        try {
          const blocks = await notion.blocks.children.list({
            block_id: normalizeNotionId(response.results[i].id),
            page_size: 100,
          });
          response.results[i]._blocks = blocks.results
            .map(formatBlockContent)
            .filter(b => b.text !== ''); // Filter empty blocks
        } catch (err) {
          logger.warn(`Failed to fetch blocks for ${response.results[i].id}: ${err.message}`);
          response.results[i]._blocks = [];
        }
      }
    }

    const formatted = formatQueryResults(response, autoExpand);
    console.log(JSON.stringify(formatted, null, 2));
  } catch (err) {
    if (err.status === 404) {
      die(`Database not found: ${databaseId}`);
    } else if (err.status === 401) {
      die('Unauthorized: Invalid or expired NOTION_API_TOKEN');
    } else {
      die(`Failed to query database: ${err.message}`);
    }
  }
}

async function getPageBlocks(notion, pageIdOrUrl, limit = 100) {
  const pageId = extractPageIdFromUrl(pageIdOrUrl);

  if (!validateNotionId(pageId)) {
    die(`Invalid Notion page ID or URL: ${pageIdOrUrl}`);
  }

  try {
    logger.info(`Fetching blocks for page: ${pageId} (limit: ${limit})`);
    const normalizedId = normalizeNotionId(pageId);

    const response = await notion.blocks.children.list({
      block_id: normalizedId,
      page_size: Math.min(limit, 100),
    });

    logger.debug(`Successfully retrieved ${response.results.length} blocks`);

    const blocks = response.results.map(formatBlockContent);
    const output = {
      pageId,
      blockCount: blocks.length,
      hasMore: response.has_more,
      blocks,
    };

    console.log(JSON.stringify(output, null, 2));
  } catch (err) {
    if (err.status === 404) {
      die(`Page not found: ${pageId}`);
    } else if (err.status === 401) {
      die('Unauthorized: Invalid or expired NOTION_API_TOKEN');
    } else {
      die(`Failed to retrieve blocks: ${err.message}`);
    }
  }
}

async function appendBlocks(notion, pageIdOrUrl, blocksJson) {
  const pageId = extractPageIdFromUrl(pageIdOrUrl);

  if (!validateNotionId(pageId)) {
    die(`Invalid Notion page ID or URL: ${pageIdOrUrl}`);
  }

  try {
    logger.info(`Appending blocks to page: ${pageId}`);
    const normalizedId = normalizeNotionId(pageId);

    let blockDefs;
    try {
      blockDefs = JSON.parse(blocksJson);
    } catch (err) {
      die(`Invalid JSON for blocks: ${err.message}`);
    }

    if (!Array.isArray(blockDefs)) {
      die('--blocks must be a JSON array');
    }

    const children = blockDefs.map(buildBlockObject);
    logger.debug(`Built ${children.length} blocks for appending`);

    const response = await notion.blocks.children.append({
      block_id: normalizedId,
      children,
    });

    logger.debug(`Successfully appended ${response.results.length} blocks`);

    const blocks = response.results.map(formatBlockContent);
    const output = {
      pageId,
      appendedCount: blocks.length,
      blocks,
    };

    console.log(JSON.stringify(output, null, 2));
  } catch (err) {
    if (err.status === 404) {
      die(`Page not found: ${pageId}`);
    } else if (err.status === 401) {
      die('Unauthorized: Invalid or expired NOTION_API_TOKEN');
    } else if (err !== CLI_EXIT) {
      die(`Failed to append blocks: ${err.message}`);
    }
  }
}

async function updateBlock(notion, blockId, text, checked) {
  if (!validateNotionId(blockId)) {
    die(`Invalid Notion block ID: ${blockId}`);
  }

  try {
    logger.info(`Updating block: ${blockId}`);
    const normalizedId = normalizeNotionId(blockId);

    // Fetch the current block to determine its type
    const currentBlock = await notion.blocks.retrieve({ block_id: normalizedId });
    const blockType = currentBlock.type;
    const blockContent = currentBlock[blockType];

    // Build update payload based on block type
    const updatePayload = {
      block_id: normalizedId,
    };

    // Handle types with rich_text
    const richTextTypes = [
      'paragraph',
      'heading_1',
      'heading_2',
      'heading_3',
      'bulleted_list_item',
      'numbered_list_item',
      'quote',
      'callout',
      'code',
      'to_do',
    ];

    if (richTextTypes.includes(blockType)) {
      if (!updatePayload[blockType]) {
        updatePayload[blockType] = {};
      }

      if (text !== null && text !== undefined) {
        updatePayload[blockType].rich_text = [{ type: 'text', text: { content: text } }];
        logger.debug(`Setting text: ${text}`);
      }

      if (blockType === 'to_do' && checked !== null && checked !== undefined) {
        updatePayload[blockType].checked = checked;
        logger.debug(`Setting checked: ${checked}`);
      }
    } else {
      die(`Block type '${blockType}' does not support text updates`);
    }

    if (Object.keys(updatePayload).length === 1) {
      die('No updates provided. Use --text or --checked');
    }

    const updatedBlock = await notion.blocks.update(updatePayload);
    logger.debug(`Successfully updated block: ${updatedBlock.id}`);

    const formatted = formatBlockContent(updatedBlock);
    const output = {
      blockId,
      block: formatted,
    };

    console.log(JSON.stringify(output, null, 2));
  } catch (err) {
    if (err.status === 404) {
      die(`Block not found: ${blockId}`);
    } else if (err.status === 401) {
      die('Unauthorized: Invalid or expired NOTION_API_TOKEN');
    } else if (err !== CLI_EXIT) {
      die(`Failed to update block: ${err.message}`);
    }
  }
}

async function deleteBlock(notion, blockId) {
  if (!validateNotionId(blockId)) {
    die(`Invalid Notion block ID: ${blockId}`);
  }

  try {
    logger.info(`Deleting block: ${blockId}`);
    const normalizedId = normalizeNotionId(blockId);

    await notion.blocks.delete({ block_id: normalizedId });

    logger.debug(`Successfully deleted block: ${blockId}`);
    const output = {
      success: true,
      blockId,
      message: 'Block deleted successfully',
    };

    console.log(JSON.stringify(output, null, 2));
  } catch (err) {
    if (err.status === 404) {
      die(`Block not found: ${blockId}`);
    } else if (err.status === 401) {
      die('Unauthorized: Invalid or expired NOTION_API_TOKEN');
    } else {
      die(`Failed to delete block: ${err.message}`);
    }
  }
}

async function getTableContent(notion, blockId) {
  if (!validateNotionId(blockId)) {
    die(`Invalid Notion block ID: ${blockId}`);
  }

  try {
    logger.info(`Fetching table content for block: ${blockId}`);
    const normalizedId = normalizeNotionId(blockId);

    // Get the table block itself
    const tableBlock = await notion.blocks.retrieve({ block_id: normalizedId });
    if (tableBlock.type !== 'table') {
      die(`Block is not a table (type: ${tableBlock.type})`);
    }

    // Get table rows (children of the table block)
    const response = await notion.blocks.children.list({
      block_id: normalizedId,
      page_size: 100,
    });

    const tableData = {
      blockId,
      type: 'table',
      hasColumnHeader: tableBlock.table.has_column_header,
      hasRowHeader: tableBlock.table.has_row_header,
      rowCount: response.results.length,
      rows: response.results.map(row => {
        const cells = [];
        if (row.type === 'table_row' && row.table_row) {
          row.table_row.cells.forEach(cell => {
            cells.push(
              cell.map(t => (t.plain_text ? t.plain_text : '')).join('')
            );
          });
        }
        return cells;
      }),
    };

    console.log(JSON.stringify(tableData, null, 2));
  } catch (err) {
    if (err.status === 404) {
      die(`Block not found: ${blockId}`);
    } else if (err.status === 401) {
      die('Unauthorized: Invalid or expired NOTION_API_TOKEN');
    } else {
      die(`Failed to retrieve table content: ${err.message}`);
    }
  }
}

async function listTableRows(notion, blockId) {
  const response = await notion.blocks.children.list({
    block_id: normalizeNotionId(blockId),
    page_size: 100,
  });

  return response.results.filter(child => child.type === 'table_row' && child.table_row);
}

async function updateTableRow(notion, blockId, rowIndex, cellsJson) {
  if (!validateNotionId(blockId)) {
    die(`Invalid Notion block ID: ${blockId}`);
  }

  if (rowIndex < 0 || !Number.isInteger(rowIndex)) {
    die('--row-index must be a non-negative integer');
  }

  const normalizedId = normalizeNotionId(blockId);

  try {
    logger.info(`Updating table row ${rowIndex} for block: ${blockId}`);
    const rows = await listTableRows(notion, normalizedId);
    if (rowIndex >= rows.length) {
      die(`Table block contains ${rows.length} rows; row-index ${rowIndex} is out of range`);
    }

    const cells = buildTableRowCells(cellsJson);
    const targetRow = rows[rowIndex];

    const updatedRow = await notion.blocks.update({
      block_id: normalizeNotionId(targetRow.id),
      table_row: {
        cells,
      },
    });

    const output = {
      blockId,
      rowIndex,
      updatedRowId: updatedRow.id,
      cells: cellsJson,
    };

    console.log(JSON.stringify(output, null, 2));
  } catch (err) {
    if (err.status === 404) {
      die(`Block not found: ${blockId}`);
    } else if (err.status === 401) {
      die('Unauthorized: Invalid or expired NOTION_API_TOKEN');
    } else {
      die(`Failed to update table row: ${err.message}`);
    }
  }
}

async function appendTableRow(notion, blockId, cellsJson) {
  if (!validateNotionId(blockId)) {
    die(`Invalid Notion block ID: ${blockId}`);
  }

  const normalizedId = normalizeNotionId(blockId);

  try {
    logger.info(`Appending table row to block: ${blockId}`);
    const cells = buildTableRowCells(cellsJson);
    const children = [
      {
        object: 'block',
        type: 'table_row',
        table_row: {
          cells,
        },
      },
    ];

    const response = await notion.blocks.children.append({
      block_id: normalizedId,
      children,
    });

    const appended = response.results[0];
    const output = {
      blockId,
      appendedRowId: appended.id,
      cells: cellsJson,
    };

    console.log(JSON.stringify(output, null, 2));
  } catch (err) {
    if (err.status === 404) {
      die(`Block not found: ${blockId}`);
    } else if (err.status === 401) {
      die('Unauthorized: Invalid or expired NOTION_API_TOKEN');
    } else {
      die(`Failed to append table row: ${err.message}`);
    }
  }
}

async function createTable(notion, pageIdOrUrl, columns, headers, rows, hasColumnHeader = true, hasRowHeader = false) {
  const pageId = extractPageIdFromUrl(pageIdOrUrl);

  if (!validateNotionId(pageId)) {
    die(`Invalid Notion page ID or URL: ${pageIdOrUrl}`);
  }

  const normalizedId = normalizeNotionId(pageId);

  let tableWidth = columns;
  if (!tableWidth && Array.isArray(headers)) {
    tableWidth = headers.length;
  }

  if (!Number.isInteger(tableWidth) || tableWidth < 1) {
    die('--columns must be a positive integer (or inferable from --headers)');
  }

  if (Array.isArray(headers) && headers.length !== tableWidth) {
    die(`--headers length (${headers.length}) must match --columns (${tableWidth})`);
  }

  const defaultHeader = new Array(tableWidth).fill('');
  const headerCells = buildTableRowCells(Array.isArray(headers) ? headers : defaultHeader);
  const additionalRows = Array.isArray(rows) ? normalizeTableRowsInput(rows, tableWidth, 'rows') : [];

  try {
    logger.info(`Creating table on page: ${pageId} (columns: ${tableWidth})`);

    const createResponse = await notion.blocks.children.append({
      block_id: normalizedId,
      children: [
        {
          object: 'block',
          type: 'table',
          table: {
            table_width: tableWidth,
            has_column_header: hasColumnHeader,
            has_row_header: hasRowHeader,
            children: [
              {
                object: 'block',
                type: 'table_row',
                table_row: {
                  cells: headerCells,
                },
              },
            ],
          },
        },
      ],
    });

    const createdTable = createResponse.results[0];
    let appendedRows = 0;

    if (additionalRows.length > 0) {
      const rowChildren = additionalRows.map(cells => ({
        object: 'block',
        type: 'table_row',
        table_row: { cells },
      }));

      await notion.blocks.children.append({
        block_id: normalizeNotionId(createdTable.id),
        children: rowChildren,
      });
      appendedRows = rowChildren.length;
    }

    console.log(JSON.stringify({
      pageId: normalizedId,
      tableBlockId: createdTable.id,
      columns: tableWidth,
      hasColumnHeader,
      hasRowHeader,
      header: Array.isArray(headers) ? headers : defaultHeader,
      appendedRowCount: appendedRows,
    }, null, 2));
  } catch (err) {
    if (err.status === 404) {
      die(`Page not found: ${pageId}`);
    } else if (err.status === 401) {
      die('Unauthorized: Invalid or expired NOTION_API_TOKEN');
    } else {
      die(`Failed to create table: ${err.message}`);
    }
  }
}

async function listComments(notion, blockIdOrUrl, limit = 50) {
  const targetId = extractPageIdFromUrl(blockIdOrUrl);
  if (!validateNotionId(targetId)) {
    die(`Invalid Notion page/block ID or URL: ${blockIdOrUrl}`);
  }

  const normalizedId = normalizeNotionId(targetId);
  let cursor = undefined;
  const comments = [];

  try {
    while (comments.length < limit) {
      const response = await notion.comments.list({
        block_id: normalizedId,
        page_size: Math.min(100, limit - comments.length),
        start_cursor: cursor,
      });

      for (const comment of response.results) {
        comments.push({
          id: comment.id,
          discussionId: comment.discussion_id,
          createdTime: comment.created_time,
          lastEditedTime: comment.last_edited_time,
          createdBy: comment.created_by?.name || comment.created_by?.id || null,
          text: getPlainTextFromRichText(comment.rich_text),
        });
      }

      if (!response.has_more || !response.next_cursor) {
        break;
      }
      cursor = response.next_cursor;
    }

    console.log(JSON.stringify({
      targetId: normalizedId,
      count: comments.length,
      comments,
    }, null, 2));
  } catch (err) {
    if (err.status === 404) {
      die(`Comment target not found: ${targetId}`);
    } else if (err.status === 401) {
      die('Unauthorized: Invalid or expired NOTION_API_TOKEN');
    } else {
      die(`Failed to list comments: ${err.message}`);
    }
  }
}

async function resolveCommentParent(notion, idOrUrl) {
  const targetId = extractPageIdFromUrl(idOrUrl);
  if (!validateNotionId(targetId)) {
    die(`Invalid Notion page/block ID or URL: ${idOrUrl}`);
  }

  const normalizedId = normalizeNotionId(targetId);

  try {
    await notion.pages.retrieve({ page_id: normalizedId });
    return { page_id: normalizedId };
  } catch (err) {
    if (err.status === 404 || err.code === 'object_not_found') {
      return { block_id: normalizedId };
    }
    throw err;
  }
}

async function createComment(notion, targetIdOrUrl, commentText) {
  if (!commentText) {
    die('--comment is required');
  }

  try {
    const parent = await resolveCommentParent(notion, targetIdOrUrl);
    const response = await notion.comments.create({
      parent,
      rich_text: [{ type: 'text', text: { content: commentText } }],
    });

    console.log(JSON.stringify({
      id: response.id,
      discussionId: response.discussion_id,
      createdTime: response.created_time,
      text: getPlainTextFromRichText(response.rich_text),
    }, null, 2));
  } catch (err) {
    if (err.status === 404) {
      die(`Comment target not found: ${targetIdOrUrl}`);
    } else if (err.status === 401) {
      die('Unauthorized: Invalid or expired NOTION_API_TOKEN');
    } else {
      die(`Failed to create comment: ${err.message}`);
    }
  }
}

async function replyComment(notion, discussionId, commentText) {
  if (!validateNotionId(discussionId)) {
    die(`Invalid discussion ID: ${discussionId}`);
  }
  if (!commentText) {
    die('--comment is required');
  }

  try {
    const response = await notion.comments.create({
      discussion_id: normalizeNotionId(discussionId),
      rich_text: [{ type: 'text', text: { content: commentText } }],
    });

    console.log(JSON.stringify({
      id: response.id,
      discussionId: response.discussion_id,
      createdTime: response.created_time,
      text: getPlainTextFromRichText(response.rich_text),
    }, null, 2));
  } catch (err) {
    if (err.status === 404) {
      die(`Discussion not found: ${discussionId}`);
    } else if (err.status === 401) {
      die('Unauthorized: Invalid or expired NOTION_API_TOKEN');
    } else {
      die(`Failed to reply comment: ${err.message}`);
    }
  }
}

async function listDatabasePages(notion, databaseIdOrUrl, limit = 50) {
  const databaseId = extractPageIdFromUrl(databaseIdOrUrl);
  if (!validateNotionId(databaseId)) {
    die(`Invalid Notion database ID or URL: ${databaseIdOrUrl}`);
  }

  const normalizedId = normalizeNotionId(databaseId);
  let cursor = undefined;
  const pages = [];

  try {
    while (pages.length < limit) {
      const response = await notion.databases.query({
        database_id: normalizedId,
        page_size: Math.min(100, limit - pages.length),
        start_cursor: cursor,
      });

      for (const item of response.results) {
        if (item.object === 'page') {
          pages.push(normalizePageSummary(item));
        }
      }

      if (!response.has_more || !response.next_cursor) {
        break;
      }
      cursor = response.next_cursor;
    }

    console.log(JSON.stringify({
      databaseId: normalizedId,
      pageCount: pages.length,
      pages,
    }, null, 2));
  } catch (err) {
    if (err.status === 404) {
      die(`Database not found: ${databaseId}`);
    } else if (err.status === 401) {
      die('Unauthorized: Invalid or expired NOTION_API_TOKEN');
    } else {
      die(`Failed to list database pages: ${err.message}`);
    }
  }
}

async function searchRoots(notion, query = '', objectType = 'all', limit = 30, includeDbRows = false, rowLimit = 20) {
  let filter = undefined;
  if (objectType === 'page' || objectType === 'database') {
    filter = { property: 'object', value: objectType };
  } else if (objectType !== 'all') {
    die('--type must be one of: all, page, database');
  }

  const results = [];
  let cursor = undefined;

  try {
    while (results.length < limit) {
      const response = await notion.search({
        query: query || undefined,
        filter,
        page_size: Math.min(100, limit - results.length),
        start_cursor: cursor,
      });

      for (const item of response.results) {
        if (item.object === 'page' || item.object === 'database') {
          results.push(formatSearchItem(item));
        }
      }

      if (!response.has_more || !response.next_cursor) {
        break;
      }
      cursor = response.next_cursor;
    }

    const roots = results.filter(item => item.isWorkspaceRoot);
    let databaseRows = [];

    if (includeDbRows) {
      const databases = roots.filter(item => item.object === 'database');
      for (const db of databases) {
        const pages = [];
        let dbCursor = undefined;

        while (pages.length < rowLimit) {
          const dbQuery = await notion.databases.query({
            database_id: normalizeNotionId(db.id),
            page_size: Math.min(100, rowLimit - pages.length),
            start_cursor: dbCursor,
          });

          for (const row of dbQuery.results) {
            if (row.object === 'page') {
              pages.push(normalizePageSummary(row));
            }
          }

          if (!dbQuery.has_more || !dbQuery.next_cursor) {
            break;
          }
          dbCursor = dbQuery.next_cursor;
        }

        databaseRows.push({
          databaseId: db.id,
          databaseTitle: db.title,
          rowCount: pages.length,
          pages,
        });
      }
    }

    console.log(JSON.stringify({
      query,
      type: objectType,
      totalMatched: results.length,
      matches: results,
      rootCount: roots.length,
      roots,
      databaseRows,
    }, null, 2));
  } catch (err) {
    if (err.status === 401) {
      die('Unauthorized: Invalid or expired NOTION_API_TOKEN');
    } else {
      die(`Failed to search roots: ${err.message}`);
    }
  }
}

async function findChildPages(notion, pageIdOrUrl, recursive = true, limit = 200) {
  const pageId = extractPageIdFromUrl(pageIdOrUrl);
  if (!validateNotionId(pageId)) {
    die(`Invalid Notion page ID or URL: ${pageIdOrUrl}`);
  }

  const normalizedRoot = normalizeNotionId(pageId);
  const queue = [{ blockId: normalizedRoot, depth: 0 }];
  const visited = new Set();
  const childPages = [];

  try {
    while (queue.length > 0 && childPages.length < limit) {
      const current = queue.shift();
      if (!current || visited.has(current.blockId)) {
        continue;
      }
      visited.add(current.blockId);

      let cursor = undefined;
      do {
        const response = await notion.blocks.children.list({
          block_id: current.blockId,
          page_size: 100,
          start_cursor: cursor,
        });

        for (const block of response.results) {
          if (block.type === 'child_page') {
            childPages.push({
              blockId: block.id,
              pageId: block.id,
              title: block.child_page?.title || '(Untitled)',
              parentBlockId: current.blockId,
              depth: current.depth + 1,
            });
            if (childPages.length >= limit) {
              break;
            }
          }

          if (recursive && block.has_children) {
            queue.push({ blockId: normalizeNotionId(block.id), depth: current.depth + 1 });
          }
        }

        cursor = response.has_more ? response.next_cursor : undefined;
      } while (cursor && childPages.length < limit);
    }

    console.log(JSON.stringify({
      rootPageId: normalizedRoot,
      recursive,
      count: childPages.length,
      childPages,
    }, null, 2));
  } catch (err) {
    if (err.status === 404) {
      die(`Page or block not found during traversal: ${err.message}`);
    } else if (err.status === 401) {
      die('Unauthorized: Invalid or expired NOTION_API_TOKEN');
    } else {
      die(`Failed to find child pages: ${err.message}`);
    }
  }
}

// ─── Help and Argument Parsing ─────────────────────────────────────────────────

function printHelp() {
  console.log(`
Usage: notion-api-cli [command] [options]

Commands:
  --get-page <page-id-or-url>           Retrieve a Notion page by ID or URL
  --update-page <page-id-or-url>        Update a Notion page
  --list-comments <target-id-or-url>    List comments for a page or block
  --create-comment <target-id-or-url>   Create a new comment on a page or block
  --reply-comment <discussion-id>       Reply to an existing discussion
  --search-roots                         Search workspace pages/databases and filter root items
  --list-database-pages <db-id-or-url>  List page rows from a database
  --find-child-pages <page-id-or-url>   Find child pages inside a page
  --create-table <page-id-or-url>       Create a new table block (with optional header/rows)
  --get-page-blocks <page-id-or-url>    Get page content blocks (paragraphs, headings, etc)
  --append-blocks <page-id-or-url>      Append new blocks to a page
  --update-block <block-id>             Update an existing block
  --delete-block <block-id>             Delete a block
  --get-table <block-id>                Get table content (rows and cells)
  --update-table-row <block-id>         Update a specific row in a table block
  --append-table-row <block-id>         Append a new row to a table block
  --get-database <db-id-or-url>         Retrieve a database structure and properties
  --query-database <db-id-or-url>       Query a database and list items

Options for --update-page:
  --title "Title"                       Set the page title
  --properties '{"Status":"Done"}'      Set additional properties as JSON
                                        Supports shorthand: select(string), checkbox(bool),
                                        multi_select(string[]), number(number)
                                        Supports typed object:
                                        {"Field":{"type":"url","value":"https://..."}}
                                        Types: url, text, number, status, date, people,
                                        email, relation, select, checkbox, multi_select
                                        Note: for shorthand values, existing field schema
                                        is auto-detected (e.g. URL field + string => url)
                                        Read-only (update not allowed): formula, created_time

Options for --append-blocks:
  --blocks '<JSON>'                     Array of block objects to append (required)
                                        Supported types: paragraph, heading_1/2/3,
                                        bulleted_list_item, numbered_list_item,
                                        to_do, quote, code, callout, divider

Options for --update-block:
  --text "new text"                     Update block text content
  --checked true|false                  Set checked state (for to_do blocks)

Options for --query-database:
  --limit <number>                      Limit results (default: 10, max: 100)
  --auto-expand                         Auto-fetch content blocks for each item

Options for comments:
  --comment "text"                      Comment body for --create-comment / --reply-comment
  --limit <number>                      Max comments for --list-comments (default: 50)

Options for --search-roots:
  --query "keyword"                     Search keyword (optional)
  --type all|page|database              Object type filter (default: all)
  --limit <number>                      Max items (default: 30)
  --include-db-rows                     Query pages for each matched root database
  --row-limit <number>                  Max rows per root database (default: 20)

Options for --list-database-pages:
  --limit <number>                      Max page rows (default: 50)

Options for --find-child-pages:
  --direct-only                         Only inspect direct children (no recursion)
  --limit <number>                      Max discovered child pages (default: 200)

Options for --create-table:
  --columns <number>                    Number of columns (required if --headers omitted)
  --headers '<JSON>'                    Header row values, e.g. ["Name","Status"]
  --rows '<JSON>'                       Additional rows, e.g. [["a","b"],["c","d"]]
  --no-column-header                    Create table without column header
  --has-row-header                      Enable row header

Options for --get-page-blocks:
  --limit <number>                      Limit blocks (default: 100)
                                        Output includes each block's id so table
                                        blocks can be passed to --get-table

Options for --update-table-row:
  --row-index <number>                  Zero-based row index to replace
  --cells '<JSON>'                      Array of strings; empty values become empty cells

Options for --append-table-row:
  --cells '<JSON>'                      Array of strings; empty values become empty cells

Page Examples:
  node notion-api-cli.js --get-page 0d5af387f61183a5b4618142b86338a5
  node notion-api-cli.js --get-page "https://www.notion.so/workspace/0d5af387f61183a5b4618142b86338a5"
  node notion-api-cli.js --get-page-blocks "https://www.notion.so/workspace/0d5af387f61183a5b4618142b86338a5"

Update Page Example:
  node notion-api-cli.js --update-page "https://www.notion.so/workspace/0d5af387f61183a5b4618142b86338a5" --title "New Title"

Comment Examples:
  node notion-api-cli.js --list-comments 0d5af387f61183a5b4618142b86338a5 --limit 20
  node notion-api-cli.js --create-comment 0d5af387f61183a5b4618142b86338a5 --comment "확인 부탁드립니다."
  node notion-api-cli.js --reply-comment 0d5af387f61183a5b4618142b86338a5 --comment "답글입니다."

Root Search Examples:
  node notion-api-cli.js --search-roots --query "SRE" --type page --limit 20
  node notion-api-cli.js --search-roots --type database --include-db-rows --row-limit 10
  node notion-api-cli.js --list-database-pages 0d5af387f61183a5b4618142b86338a5 --limit 30
  node notion-api-cli.js --find-child-pages 0d5af387f61183a5b4618142b86338a5
  node notion-api-cli.js --create-table 0d5af387f61183a5b4618142b86338a5 --headers '["항목","상태"]' --rows '[["A","진행"],["B","완료"]]'

Block Examples:
  node notion-api-cli.js --append-blocks 0d5af387f61183a5b4618142b86338a5 --blocks '[{"type":"paragraph","text":"Hello world"},{"type":"heading_2","text":"Section"}]'
  node notion-api-cli.js --append-blocks 0d5af387f61183a5b4618142b86338a5 --blocks '[{"type":"to_do","text":"Task","checked":false},{"type":"code","text":"console.log(1)","language":"javascript"}]'
  node notion-api-cli.js --update-block 0d5af387f61183a5b4618142b86338a5 --text "Updated text"
  node notion-api-cli.js --update-block 0d5af387f61183a5b4618142b86338a5 --checked true
  node notion-api-cli.js --delete-block 0d5af387f61183a5b4618142b86338a5
  node notion-api-cli.js --get-table 0d5af387f61183a5b4618142b86338a5

Database Examples:
  node notion-api-cli.js --get-database "https://www.notion.so/workspace/0d5af387f61183a5b4618142b86338a5"
  node notion-api-cli.js --query-database "https://www.notion.so/workspace/0d5af387f61183a5b4618142b86338a5" --limit 5
  node notion-api-cli.js --query-database "https://www.notion.so/workspace/0d5af387f61183a5b4618142b86338a5" --limit 5 --auto-expand

Environment:
  NOTION_API_TOKEN                      Notion integration token (required)
  LOG_LEVEL                             Logging level (default: info)
  NODE_ENV                              Environment (development/production)

Setup:
  1. Create a .env file from .env.example
  2. Add your Notion integration token: https://www.notion.so/my-integrations
  3. Run the CLI
`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    exitCli(0);
    return;
  }

  try {
    const notion = initializeNotionClient();

    if (args[0] === '--get-page') {
      const pageId = args[1];
      if (!pageId) {
        die('--get-page requires a page ID or URL');
      }
      await getPage(notion, pageId);
    } else if (args[0] === '--update-page') {
      const pageId = args[1];
      if (!pageId) {
        die('--update-page requires a page ID or URL');
      }

      let title = null;
      let propertiesJson = null;

      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--title' && args[i + 1]) {
          title = args[++i];
        } else if (args[i] === '--properties' && args[i + 1]) {
          propertiesJson = args[++i];
        }
      }

      await updatePage(notion, pageId, title, propertiesJson);
    } else if (args[0] === '--list-comments') {
      const targetId = args[1];
      if (!targetId) {
        die('--list-comments requires a page/block ID or URL');
      }

      let limit = 50;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--limit' && args[i + 1]) {
          limit = parseInt(args[++i], 10);
          if (isNaN(limit) || limit < 1) {
            die('--limit must be a positive number');
          }
        }
      }

      await listComments(notion, targetId, limit);
    } else if (args[0] === '--create-comment') {
      const targetId = args[1];
      if (!targetId) {
        die('--create-comment requires a page/block ID or URL');
      }

      let commentText = null;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--comment' && args[i + 1]) {
          commentText = args[++i];
        }
      }

      if (!commentText) {
        die('--create-comment requires --comment "text"');
      }

      await createComment(notion, targetId, commentText);
    } else if (args[0] === '--reply-comment') {
      const discussionId = args[1];
      if (!discussionId) {
        die('--reply-comment requires a discussion ID');
      }

      let commentText = null;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--comment' && args[i + 1]) {
          commentText = args[++i];
        }
      }

      if (!commentText) {
        die('--reply-comment requires --comment "text"');
      }

      await replyComment(notion, discussionId, commentText);
    } else if (args[0] === '--search-roots') {
      let query = '';
      let type = 'all';
      let limit = 30;
      let includeDbRows = false;
      let rowLimit = 20;

      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--query' && args[i + 1]) {
          query = args[++i];
        } else if (args[i] === '--type' && args[i + 1]) {
          type = args[++i];
        } else if (args[i] === '--limit' && args[i + 1]) {
          limit = parseInt(args[++i], 10);
          if (isNaN(limit) || limit < 1) {
            die('--limit must be a positive number');
          }
        } else if (args[i] === '--include-db-rows') {
          includeDbRows = true;
        } else if (args[i] === '--row-limit' && args[i + 1]) {
          rowLimit = parseInt(args[++i], 10);
          if (isNaN(rowLimit) || rowLimit < 1) {
            die('--row-limit must be a positive number');
          }
        }
      }

      await searchRoots(notion, query, type, limit, includeDbRows, rowLimit);
    } else if (args[0] === '--list-database-pages') {
      const databaseId = args[1];
      if (!databaseId) {
        die('--list-database-pages requires a database ID or URL');
      }

      let limit = 50;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--limit' && args[i + 1]) {
          limit = parseInt(args[++i], 10);
          if (isNaN(limit) || limit < 1) {
            die('--limit must be a positive number');
          }
        }
      }

      await listDatabasePages(notion, databaseId, limit);
    } else if (args[0] === '--find-child-pages') {
      const pageId = args[1];
      if (!pageId) {
        die('--find-child-pages requires a page ID or URL');
      }

      let recursive = true;
      let limit = 200;

      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--direct-only') {
          recursive = false;
        } else if (args[i] === '--limit' && args[i + 1]) {
          limit = parseInt(args[++i], 10);
          if (isNaN(limit) || limit < 1) {
            die('--limit must be a positive number');
          }
        }
      }

      await findChildPages(notion, pageId, recursive, limit);
    } else if (args[0] === '--create-table') {
      const pageId = args[1];
      if (!pageId) {
        die('--create-table requires a page ID or URL');
      }

      let columns = null;
      let headers = null;
      let rows = null;
      let hasColumnHeader = true;
      let hasRowHeader = false;

      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--columns' && args[i + 1]) {
          columns = parseInt(args[++i], 10);
          if (isNaN(columns) || columns < 1) {
            die('--columns must be a positive integer');
          }
        } else if (args[i] === '--headers' && args[i + 1]) {
          headers = parseJsonOption(args[++i], 'headers');
        } else if (args[i] === '--rows' && args[i + 1]) {
          rows = parseJsonOption(args[++i], 'rows');
        } else if (args[i] === '--no-column-header') {
          hasColumnHeader = false;
        } else if (args[i] === '--has-row-header') {
          hasRowHeader = true;
        }
      }

      await createTable(notion, pageId, columns, headers, rows, hasColumnHeader, hasRowHeader);
    } else if (args[0] === '--get-page-blocks') {
      const pageId = args[1];
      if (!pageId) {
        die('--get-page-blocks requires a page ID or URL');
      }

      let limit = 100;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--limit' && args[i + 1]) {
          limit = parseInt(args[++i], 10);
          if (isNaN(limit) || limit < 1) {
            die('--limit must be a positive number');
          }
        }
      }

      await getPageBlocks(notion, pageId, limit);
    } else if (args[0] === '--append-blocks') {
      const pageId = args[1];
      if (!pageId) {
        die('--append-blocks requires a page ID or URL');
      }

      let blocksJson = null;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--blocks' && args[i + 1]) {
          blocksJson = args[++i];
        }
      }

      if (!blocksJson) {
        die('--append-blocks requires --blocks option with JSON array');
      }

      await appendBlocks(notion, pageId, blocksJson);
    } else if (args[0] === '--update-block') {
      const blockId = args[1];
      if (!blockId) {
        die('--update-block requires a block ID');
      }

      let text = null;
      let checked = null;

      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--text' && args[i + 1]) {
          text = args[++i];
        } else if (args[i] === '--checked' && args[i + 1]) {
          const checkedStr = args[++i].toLowerCase();
          if (checkedStr === 'true') {
            checked = true;
          } else if (checkedStr === 'false') {
            checked = false;
          } else {
            die('--checked must be true or false');
          }
        }
      }

      await updateBlock(notion, blockId, text, checked);
    } else if (args[0] === '--delete-block') {
      const blockId = args[1];
      if (!blockId) {
        die('--delete-block requires a block ID');
      }

      await deleteBlock(notion, blockId);
    } else if (args[0] === '--get-table') {
      const blockId = args[1];
      if (!blockId) {
        die('--get-table requires a block ID');
      }

      await getTableContent(notion, blockId);
    } else if (args[0] === '--update-table-row') {
      const blockId = args[1];
      if (!blockId) {
        die('--update-table-row requires a block ID');
      }

      let rowIndex = null;
      let cellsOption = null;

      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--row-index' && args[i + 1]) {
          rowIndex = parseInt(args[++i], 10);
          if (isNaN(rowIndex) || rowIndex < 0) {
            die('--row-index must be a non-negative integer');
          }
        } else if (args[i] === '--cells' && args[i + 1]) {
          cellsOption = args[++i];
        }
      }

      if (rowIndex === null) {
        die('--update-table-row requires --row-index');
      }

      if (!cellsOption) {
        die('--update-table-row requires --cells');
      }

      const cellsJson = parseJsonOption(cellsOption, 'cells');
      await updateTableRow(notion, blockId, rowIndex, cellsJson);
    } else if (args[0] === '--append-table-row') {
      const blockId = args[1];
      if (!blockId) {
        die('--append-table-row requires a block ID');
      }

      let cellsOption = null;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--cells' && args[i + 1]) {
          cellsOption = args[++i];
        }
      }

      if (!cellsOption) {
        die('--append-table-row requires --cells');
      }

      const cellsJson = parseJsonOption(cellsOption, 'cells');
      await appendTableRow(notion, blockId, cellsJson);
    } else if (args[0] === '--get-database') {
      const databaseId = args[1];
      if (!databaseId) {
        die('--get-database requires a database ID or URL');
      }
      await getDatabase(notion, databaseId);
    } else if (args[0] === '--query-database') {
      const databaseId = args[1];
      if (!databaseId) {
        die('--query-database requires a database ID or URL');
      }

      let limit = 10;
      let autoExpand = false;

      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--limit' && args[i + 1]) {
          limit = parseInt(args[++i], 10);
          if (isNaN(limit) || limit < 1) {
            die('--limit must be a positive number');
          }
        } else if (args[i] === '--auto-expand') {
          autoExpand = true;
        }
      }

      await queryDatabase(notion, databaseId, limit, autoExpand);
    } else {
      die(`Unknown command: ${args[0]}`);
    }

    exitCli(0);
  } catch (err) {
    if (err !== CLI_EXIT) {
      logger.error(`Unexpected error: ${err.message}`, { stack: err.stack });
      exitCli(1);
    }
  }
}

main();
