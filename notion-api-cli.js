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

function handleNotionError(err, notFoundMessage) {
  if (err === CLI_EXIT) {
    throw err;
  }
  if (err.status === 404 && notFoundMessage) {
    die(notFoundMessage);
  } else if (err.status === 401) {
    die('Unauthorized: Invalid or expired NOTION_API_TOKEN');
  }
  die(err.message);
}

// ─── Output ──────────────────────────────────────────────────────────────────
// 이 CLI의 주 소비자는 에이전트이므로 출력 1바이트가 곧 컨텍스트 예산입니다.
// 기본은 compact JSON + 빈 필드 제거이고, 아래 플래그로 예전 동작을 복원합니다.

const OUTPUT = {
  pretty: false,
  verboseFields: false,
  includeIds: true,
};

// null/undefined/빈 문자열/빈 배열 프로퍼티를 재귀적으로 제거합니다.
// 배열 원소는 인덱스 자체가 의미를 가지므로(테이블 행 등) 걷어내지 않습니다.
function prune(value) {
  if (Array.isArray(value)) {
    return value.map(prune);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null || raw === undefined || raw === '') {
      continue;
    }
    if (Array.isArray(raw) && raw.length === 0) {
      continue;
    }
    result[key] = prune(raw);
  }
  return result;
}

function emit(payload) {
  const shaped = OUTPUT.verboseFields ? payload : prune(payload);
  console.log(JSON.stringify(shaped, null, OUTPUT.pretty ? 2 : undefined));
}

// --no-ids일 때 조회 결과에서 UUID를 걷어냅니다. 100블록 페이지에서 UUID만
// 3.6KB 남짓이라 읽기 전용 조회에서는 통째로 비우는 편이 이득입니다.
function withId(id) {
  return OUTPUT.includeIds ? id : undefined;
}

// ─── Concurrency ─────────────────────────────────────────────────────────────
// Notion API는 평균 초당 3요청을 권장하므로 기본 동시성을 낮게 유지합니다.
async function mapWithConcurrency(items, fn, limit = 5) {
  const results = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

// ─── Helper Functions ────────────────────────────────────────────────────────

// 32자리 hex 또는 하이픈이 들어간 UUID 형태를 모두 받습니다.
const NOTION_ID_PATTERN = '[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// notion.so와 notion.com을 모두 인식합니다. Notion이 app.notion.com으로
// 도메인을 옮기면서 "복사한 링크 붙여넣기"가 통째로 거부되던 문제가 있었습니다.
const NOTION_URL_HOST = /(?:^|\/\/)(?:[\w-]+\.)?notion\.(?:so|com)\//i;

// ?p=<id>: 데이터베이스 뷰에서 페이지를 사이드 피크로 열었을 때의 형태.
// 이때 경로의 id는 데이터베이스이고 실제 대상은 p= 쪽이라 먼저 봅니다.
const NOTION_PEEK_PARAM = new RegExp(`[?&]p=(${NOTION_ID_PATTERN})(?:[&#]|$)`, 'i');

// 경로 마지막 조각의 id. 앞의 워크스페이스 세그먼트와 제목 슬러그를 건너뜁니다.
// ?v=<view-id> 같은 쿼리는 [^?#]로 막아 두어 뷰 id를 페이지 id로 오인하지 않습니다.
const NOTION_PATH_ID = new RegExp(
  `notion\\.(?:so|com)/(?:[^?#]*/)?(?:[^/?#]*-)?(${NOTION_ID_PATTERN})(?:[/?#]|$)`,
  'i'
);

function extractPageIdFromUrl(input) {
  const trimmed = String(input).trim();

  // 지원 형태:
  //   https://www.notion.so/{workspace}/{slug}-{id}?v=...
  //   https://app.notion.com/p/{id}?v=...
  //   https://app.notion.com/{workspace}/{slug}-{id}
  //   https://www.notion.so/{workspace}/{db-id}?v={view-id}&p={page-id}
  if (NOTION_URL_HOST.test(trimmed)) {
    const match = trimmed.match(NOTION_PEEK_PARAM) || trimmed.match(NOTION_PATH_ID);
    if (match) {
      return normalizeNotionId(match[1]);
    }
  }

  // URL이 아니면 ID로 보고 그대로 넘깁니다 (검증은 validateNotionId가 합니다).
  return normalizeNotionId(trimmed);
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
      return formatDateValue(prop.date);
    case 'url':
      return prop.url || null;
    case 'email':
      return prop.email || null;
    case 'phone_number':
      return prop.phone_number || null;
    case 'number':
      return prop.number;
    case 'people':
      return formatPeopleValue(prop.people);
    case 'created_by':
      return OUTPUT.verboseFields ? prop.created_by : (prop.created_by?.name || prop.created_by?.id || null);
    case 'last_edited_by':
      return OUTPUT.verboseFields ? prop.last_edited_by : (prop.last_edited_by?.name || prop.last_edited_by?.id || null);
    case 'relation':
      return prop.relation.map(r => r.id);
    case 'files':
      return (prop.files || []).map(f => f.name || f.file?.url || f.external?.url || null);
    case 'formula':
      return formatFormulaValue(prop.formula);
    case 'rollup':
      return formatRollupValue(prop.rollup);
    case 'created_time':
      return prop.created_time || null;
    case 'last_edited_time':
      return prop.last_edited_time || null;
    case 'unique_id':
      return prop.unique_id
        ? [prop.unique_id.prefix, prop.unique_id.number].filter(v => v !== null && v !== undefined).join('-')
        : null;
    default:
      return `[${prop.type}]`;
  }
}

// end/time_zone은 대부분 null이므로 start만 있으면 문자열로 축약합니다.
function formatDateValue(date) {
  if (!date) {
    return null;
  }
  if (OUTPUT.verboseFields) {
    return date;
  }
  if (!date.end && !date.time_zone) {
    return date.start || null;
  }
  return date;
}

function formatPeopleValue(people) {
  if (!Array.isArray(people)) {
    return [];
  }
  if (OUTPUT.verboseFields) {
    return people.map(p => ({ id: p.id, name: p.name || null, type: p.type || 'person' }));
  }
  return people.map(p => p.name || p.id);
}

// {type:'number', number:42} 대신 값만 남깁니다.
function formatFormulaValue(formula) {
  if (!formula) {
    return null;
  }
  if (OUTPUT.verboseFields) {
    return formula;
  }
  const inner = formula[formula.type];
  return inner === undefined ? formula : (formula.type === 'date' ? formatDateValue(inner) : inner);
}

function formatRollupValue(rollup) {
  if (!rollup) {
    return null;
  }
  if (OUTPUT.verboseFields) {
    return rollup;
  }
  if (rollup.type === 'array') {
    return (rollup.array || []).map(formatPropertyValue);
  }
  if (rollup.type === 'date') {
    return formatDateValue(rollup.date);
  }
  const inner = rollup[rollup.type];
  return inner === undefined ? rollup : inner;
}

function formatPageOutput(page) {
  return {
    id: withId(page.id),
    url: withId(page.url),
    // 제목 프로퍼티명은 워크스페이스마다 다르므로(Name/이름/…) 키가 아닌
    // 타입으로 찾아야 합니다. extractTitleFromPage가 그 일을 합니다.
    title: extractTitleFromPage(page),
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
    id: withId(database.id),
    url: withId(database.url),
    title: database.title?.[0]?.plain_text || '(Untitled)',
    createdTime: database.created_time,
    lastEditedTime: database.last_edited_time,
    properties: Object.entries(database.properties).reduce((acc, [key, prop]) => {
      acc[key] = formatSchemaProperty(prop);
      return acc;
    }, {}),
  };
}

// 스키마 조회에서 실제로 필요한 건 타입과 선택지 이름입니다. 원본 config는
// 옵션마다 id/color를 달고 있어 프로퍼티 하나가 수백 바이트씩 나갑니다.
function formatSchemaProperty(prop) {
  if (OUTPUT.verboseFields) {
    return { id: prop.id, type: prop.type, config: prop[prop.type] || {} };
  }

  const shaped = { id: withId(prop.id), type: prop.type };
  const config = prop[prop.type];

  switch (prop.type) {
    case 'select':
    case 'multi_select':
    case 'status':
      shaped.options = (config?.options || []).map(o => o.name);
      break;
    case 'relation':
      shaped.relatedDatabaseId = config?.database_id;
      break;
    case 'formula':
      shaped.expression = config?.expression;
      break;
    case 'rollup':
      shaped.rollup = config
        ? `${config.function}(${config.relation_property_name}.${config.rollup_property_name})`
        : undefined;
      break;
    case 'number':
      shaped.format = config?.format;
      break;
    default:
      break;
  }

  return shaped;
}

function formatQueryResults(rows, includeBlocks = false, hasMore = false) {
  return {
    count: rows.length,
    results: rows.map(item => {
      const props = {};
      Object.entries(item.properties || {}).forEach(([key, prop]) => {
        props[key] = formatPropertyValue(prop);
      });

      const result = {
        id: withId(item.id),
        url: withId(item.url),
        properties: props,
      };

      if (includeBlocks && item._blocks) {
        result.blocks = item._blocks;
      }

      return result;
    }),
    hasMore,
  };
}

// 대다수 블록은 color가 'default'라 그대로 실으면 순수 낭비입니다.
function blockColor(content) {
  if (!content || !content.color || content.color === 'default') {
    return undefined;
  }
  return content.color;
}

// paragraph/heading/list/quote는 rich_text 하나만 다른 동일 구조라 공통화합니다.
const RICH_TEXT_BLOCK_TYPES = new Set([
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'bulleted_list_item',
  'numbered_list_item',
  'quote',
  'toggle',
]);

function formatBlockContent(block) {
  const type = block.type;
  const content = block[type];
  const base = { id: withId(block.id), type };

  if (RICH_TEXT_BLOCK_TYPES.has(type)) {
    return {
      ...base,
      text: getPlainTextFromRichText(content?.rich_text),
      color: blockColor(content),
    };
  }

  switch (type) {
    case 'to_do':
      return {
        ...base,
        text: getPlainTextFromRichText(content.rich_text),
        // checked:false는 prune에 걸리지 않도록 항상 유지해야 의미가 보존됩니다.
        checked: content.checked === true,
        color: blockColor(content),
      };
    case 'callout':
      return {
        ...base,
        text: getPlainTextFromRichText(content.rich_text),
        icon: content.icon?.emoji || content.icon?.external?.url || content.icon?.file?.url || undefined,
        color: blockColor(content),
      };
    case 'code':
      return {
        ...base,
        text: getPlainTextFromRichText(content.rich_text),
        language: content.language,
      };
    case 'divider':
      return base;
    case 'image':
    case 'video':
    case 'file':
    case 'pdf':
      return {
        ...base,
        url: content.file?.url || content.external?.url,
        caption: getPlainTextFromRichText(content.caption),
      };
    case 'table':
      return {
        ...base,
        hasColumnHeader: content.has_column_header,
        hasRowHeader: content.has_row_header,
        cellsInfo: '(use --get-table for full table content)',
      };
    case 'table_row':
      return {
        ...base,
        cells: (content.cells || []).map(getPlainTextFromRichText),
      };
    case 'bookmark':
    case 'embed':
    case 'link_preview':
      return { ...base, url: content.url };
    case 'child_page':
      return { ...base, title: content.title || '(Untitled)' };
    case 'child_database':
      return { ...base, title: content.title || '(Untitled)' };
    case 'equation':
      return { ...base, expression: content.expression };
    default:
      return { ...base, note: `[${type} block - not fully supported]` };
  }
}

// Notion 은 children.append 에 after 를 받아 특정 블록 뒤에 끼워 넣는다.
// 없으면 항상 끝에 붙어서, 이미 뒤에 블록이 있으면 순서를 맞출 수 없다.
function afterOption(after) {
  if (!after) {
    return {};
  }
  if (!validateNotionId(after)) {
    die(`Invalid block ID for --after: ${after}`);
  }
  return { after: normalizeNotionId(after) };
}

function buildBlockObject(blockDef) {
  const { type, text, checked, language, icon, color, children } = blockDef;
  const blockObj = {};

  // toggle처럼 자식을 품는 블록을 위해 재귀 변환합니다.
  const buildChildren = () =>
    Array.isArray(children) && children.length > 0
      ? { children: children.map(buildBlockObject) }
      : {};

  switch (type) {
    case 'toggle':
      blockObj.object = 'block';
      blockObj.type = 'toggle';
      blockObj.toggle = {
        rich_text: text ? [{ type: 'text', text: { content: text } }] : [],
        color: color || 'default',
        ...buildChildren(),
      };
      return blockObj;

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
        color: color || 'default',
        ...buildChildren(),
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
    id: withId(item.id),
    url: withId(item.url),
    title: extractTitleFromSearchItem(item),
    parentType: parentInfo.parentType,
    parentId: parentInfo.parentId,
    // false는 prune으로 사라지므로 루트일 때만 실어 보냅니다.
    isWorkspaceRoot: parentInfo.isWorkspaceRoot || undefined,
  };
}

function normalizePageSummary(page) {
  const parentInfo = parseParentInfo(page);
  return {
    id: withId(page.id),
    url: withId(page.url),
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
    emit(formatted);
  } catch (err) {
    handleNotionError(err, `Page not found: ${pageId}`);
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
    emit(formatted);
  } catch (err) {
    handleNotionError(err, `Page not found: ${pageId}`);
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
    emit(formatted);
  } catch (err) {
    handleNotionError(err, `Database not found: ${databaseId}`);
  }
}

// --properties Name,Status → filter_properties. Notion은 이름이 아닌 property ID를
// 요구하므로 스키마를 한 번 조회해 매핑합니다. 이름이 틀리면 조용히 무시하지 않고
// 알려줍니다 — 조용한 누락은 "그 값이 비어 있다"로 오독되기 때문입니다.
async function resolvePropertyIds(notion, normalizedId, propertyNames) {
  const database = await notion.databases.retrieve({ database_id: normalizedId });
  const schema = database.properties || {};

  const ids = [];
  const unknown = [];

  for (const name of propertyNames) {
    const prop = schema[name];
    if (prop && prop.id) {
      ids.push(prop.id);
    } else {
      unknown.push(name);
    }
  }

  if (unknown.length > 0) {
    die(
      `Unknown propert${unknown.length > 1 ? 'ies' : 'y'} for this database: ${unknown.join(', ')}. ` +
      `Available: ${Object.keys(schema).join(', ')}`
    );
  }

  return ids;
}

// 커서를 따라가며 limit에 도달할 때까지 모읍니다. 예전 queryDatabase는 한 번만
// 호출해 --limit 500을 줘도 조용히 100건만 반환했습니다.
async function fetchDatabaseRows(notion, normalizedId, options = {}) {
  const { limit = 10, filter, sorts, filterProperties } = options;

  const rows = [];
  let cursor = undefined;
  // 마지막 응답 기준으로만 판단해야 합니다. 중간 응답의 has_more를 들고 있으면
  // 데이터가 정확히 limit에서 끝났을 때 hasMore를 잘못 true로 보고합니다.
  let hasMore = false;

  while (rows.length < limit) {
    const response = await notion.databases.query({
      database_id: normalizedId,
      page_size: Math.min(100, limit - rows.length),
      start_cursor: cursor,
      ...(filter ? { filter } : {}),
      ...(sorts ? { sorts } : {}),
      ...(filterProperties ? { filter_properties: filterProperties } : {}),
    });

    for (const item of response.results) {
      if (item.object === 'page') {
        rows.push(item);
      }
    }

    hasMore = Boolean(response.has_more && response.next_cursor);
    if (!hasMore) {
      break;
    }
    cursor = response.next_cursor;
  }

  return { rows: rows.slice(0, limit), hasMore };
}

async function expandRowBlocks(notion, rows) {
  logger.info(`Auto-expanding ${rows.length} items...`);

  await mapWithConcurrency(rows, async row => {
    try {
      const blocks = await notion.blocks.children.list({
        block_id: normalizeNotionId(row.id),
        page_size: 100,
      });
      row._blocks = blocks.results
        .map(formatBlockContent)
        // divider/image처럼 text 필드가 아예 없는 블록은 남기고,
        // 텍스트 블록 중 내용이 빈 것만 걸러냅니다.
        .filter(b => b.text === undefined || b.text !== '');
    } catch (err) {
      logger.warn(`Failed to fetch blocks for ${row.id}: ${err.message}`);
      row._blocks = [];
    }
  });
}

async function queryDatabase(notion, databaseIdOrUrl, limit = 10, autoExpand = false, queryOptions = {}) {
  const databaseId = extractPageIdFromUrl(databaseIdOrUrl);

  if (!validateNotionId(databaseId)) {
    die(`Invalid Notion database ID or URL: ${databaseIdOrUrl}`);
  }

  try {
    logger.info(`Querying database: ${databaseId} (limit: ${limit})`);
    const normalizedId = normalizeNotionId(databaseId);

    const filterProperties = queryOptions.properties
      ? await resolvePropertyIds(notion, normalizedId, queryOptions.properties)
      : undefined;

    const { rows, hasMore } = await fetchDatabaseRows(notion, normalizedId, {
      limit,
      filter: queryOptions.filter,
      sorts: queryOptions.sorts,
      filterProperties,
    });

    logger.debug(`Successfully queried database: ${rows.length} items`);

    if (autoExpand) {
      await expandRowBlocks(notion, rows);
    }

    emit(formatQueryResults(rows, autoExpand, hasMore));
  } catch (err) {
    handleNotionError(err, `Database not found: ${databaseId}`);
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

    emit(output);
  } catch (err) {
    handleNotionError(err, `Page not found: ${pageId}`);
  }
}

async function appendBlocks(notion, pageIdOrUrl, blocksJson, after = null) {
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
      ...afterOption(after),
    });

    logger.debug(`Successfully appended ${response.results.length} blocks`);

    const blocks = response.results.map(formatBlockContent);
    const output = {
      pageId,
      appendedCount: blocks.length,
      blocks,
    };

    emit(output);
  } catch (err) {
    handleNotionError(err, `Page not found: ${pageId}`);
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

    emit(output);
  } catch (err) {
    handleNotionError(err, `Block not found: ${blockId}`);
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

    emit(output);
  } catch (err) {
    handleNotionError(err, `Block not found: ${blockId}`);
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

    // 행 조회는 listTableRows로 일원화합니다 — 예전에는 여기서 따로 한 번 더
    // children을 읽었고, 그쪽이 페이지네이션을 하지 않아 100행에서 잘렸습니다.
    const rows = await listTableRows(notion, normalizedId);

    const tableData = {
      blockId,
      type: 'table',
      hasColumnHeader: tableBlock.table.has_column_header,
      hasRowHeader: tableBlock.table.has_row_header,
      rowCount: rows.length,
      rows: rows.map(row => (row.table_row.cells || []).map(getPlainTextFromRichText)),
    };

    emit(tableData);
  } catch (err) {
    handleNotionError(err, `Block not found: ${blockId}`);
  }
}

// 커서를 끝까지 따라갑니다. 100행 상한이 있던 시절에는 101번째 이후 행이
// 존재하지 않는 것처럼 보여 --update-table-row가 잘못 실패했습니다.
async function listTableRows(notion, blockId) {
  const normalizedId = normalizeNotionId(blockId);
  const rows = [];
  let cursor = undefined;

  do {
    const response = await notion.blocks.children.list({
      block_id: normalizedId,
      page_size: 100,
      start_cursor: cursor,
    });

    for (const child of response.results) {
      if (child.type === 'table_row' && child.table_row) {
        rows.push(child);
      }
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return rows;
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

    emit(output);
  } catch (err) {
    handleNotionError(err, `Block not found: ${blockId}`);
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

    emit(output);
  } catch (err) {
    handleNotionError(err, `Block not found: ${blockId}`);
  }
}

async function createTable(notion, pageIdOrUrl, columns, headers, rows, hasColumnHeader = true, hasRowHeader = false, after = null) {
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
      ...afterOption(after),
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

    emit({
      pageId: normalizedId,
      tableBlockId: createdTable.id,
      columns: tableWidth,
      hasColumnHeader,
      hasRowHeader,
      header: Array.isArray(headers) ? headers : defaultHeader,
      appendedRowCount: appendedRows,
    });
  } catch (err) {
    handleNotionError(err, `Page not found: ${pageId}`);
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

    emit({
      targetId: normalizedId,
      count: comments.length,
      comments,
    });
  } catch (err) {
    handleNotionError(err, `Comment target not found: ${targetId}`);
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

    emit({
      id: response.id,
      discussionId: response.discussion_id,
      createdTime: response.created_time,
      text: getPlainTextFromRichText(response.rich_text),
    });
  } catch (err) {
    handleNotionError(err, `Comment target not found: ${targetIdOrUrl}`);
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

    emit({
      id: response.id,
      discussionId: response.discussion_id,
      createdTime: response.created_time,
      text: getPlainTextFromRichText(response.rich_text),
    });
  } catch (err) {
    handleNotionError(err, `Discussion not found: ${discussionId}`);
  }
}

async function listDatabasePages(notion, databaseIdOrUrl, limit = 50) {
  const databaseId = extractPageIdFromUrl(databaseIdOrUrl);
  if (!validateNotionId(databaseId)) {
    die(`Invalid Notion database ID or URL: ${databaseIdOrUrl}`);
  }

  const normalizedId = normalizeNotionId(databaseId);

  try {
    const { rows, hasMore } = await fetchDatabaseRows(notion, normalizedId, { limit });

    emit({
      databaseId: normalizedId,
      pageCount: rows.length,
      hasMore: hasMore || undefined,
      pages: rows.map(normalizePageSummary),
    });
  } catch (err) {
    handleNotionError(err, `Database not found: ${databaseId}`);
  }
}

async function searchRoots(notion, query = '', objectType = 'all', limit = 30, includeDbRows = false, rowLimit = 20) {
  let filter = undefined;
  if (objectType === 'page' || objectType === 'database') {
    filter = { property: 'object', value: objectType };
  } else if (objectType !== 'all') {
    die('--type must be one of: all, page, database');
  }

  // 원본 항목을 함께 들고 다닙니다. --no-ids로 포맷 결과에서 id가 빠져도
  // 뒤이은 DB 조회는 실제 id가 있어야 하기 때문입니다.
  const items = [];
  let cursor = undefined;

  try {
    while (items.length < limit) {
      const response = await notion.search({
        query: query || undefined,
        filter,
        page_size: Math.min(100, limit - items.length),
        start_cursor: cursor,
      });

      for (const item of response.results) {
        if (item.object === 'page' || item.object === 'database') {
          items.push(item);
        }
      }

      if (!response.has_more || !response.next_cursor) {
        break;
      }
      cursor = response.next_cursor;
    }

    const rootItems = items.filter(item => parseParentInfo(item).isWorkspaceRoot);
    let databaseRows = [];

    if (includeDbRows) {
      const databases = rootItems.filter(item => item.object === 'database');
      databaseRows = await mapWithConcurrency(databases, async db => {
        const { rows } = await fetchDatabaseRows(notion, normalizeNotionId(db.id), { limit: rowLimit });
        return {
          databaseId: db.id,
          databaseTitle: extractTitleFromSearchItem(db),
          rowCount: rows.length,
          pages: rows.map(normalizePageSummary),
        };
      });
    }

    // matches는 각 항목의 isWorkspaceRoot로 루트 여부를 이미 담고 있습니다.
    // 예전에는 같은 객체를 roots로 한 번 더 실어 보내 통째로 중복됐습니다.
    emit({
      query,
      type: objectType,
      totalMatched: items.length,
      rootCount: rootItems.length,
      matches: items.map(formatSearchItem),
      databaseRows,
    });
  } catch (err) {
    handleNotionError(err);
  }
}

// child_page를 품을 수 있는 컨테이너만 나열합니다. 문단·이미지·테이블 같은
// 블록은 has_children이어도 하위 페이지를 담지 않으므로 내려갈 이유가 없습니다.
const TRAVERSABLE_BLOCK_TYPES = new Set([
  'toggle',
  'column_list',
  'column',
  'synced_block',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'callout',
  'quote',
  'paragraph',
  'template',
  'child_page',
  'heading_1',
  'heading_2',
  'heading_3',
]);

async function listChildBlocks(notion, blockId) {
  const blocks = [];
  let cursor = undefined;

  do {
    const response = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      start_cursor: cursor,
    });
    blocks.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return blocks;
}

async function findChildPages(notion, pageIdOrUrl, recursive = true, limit = 200, maxDepth = 3, deep = false) {
  const pageId = extractPageIdFromUrl(pageIdOrUrl);
  if (!validateNotionId(pageId)) {
    die(`Invalid Notion page ID or URL: ${pageIdOrUrl}`);
  }

  const normalizedRoot = normalizeNotionId(pageId);
  let frontier = [{ blockId: normalizedRoot, depth: 0 }];
  const visited = new Set();
  const childPages = [];

  try {
    while (frontier.length > 0 && childPages.length < limit) {
      const level = frontier.filter(node => {
        if (visited.has(node.blockId)) {
          return false;
        }
        visited.add(node.blockId);
        return true;
      });

      if (level.length === 0) {
        break;
      }

      // 같은 깊이의 노드는 서로 의존이 없으므로 동시에 훑습니다.
      const expansions = await mapWithConcurrency(level, node => listChildBlocks(notion, node.blockId));

      const next = [];
      for (let i = 0; i < level.length; i++) {
        const node = level[i];
        const depth = node.depth + 1;

        for (const block of expansions[i]) {
          if (block.type === 'child_page' || block.type === 'child_database') {
            if (childPages.length < limit) {
              childPages.push({
                blockId: block.id,
                pageId: block.id,
                object: block.type === 'child_database' ? 'database' : 'page',
                title: block[block.type]?.title || '(Untitled)',
                parentBlockId: node.blockId,
                depth,
              });
            }
            // child_page는 그 자체가 has_children이라 예전에는 하위 페이지
            // 내부까지 전부 내려갔습니다. --deep일 때만 들어갑니다.
            if (!deep) {
              continue;
            }
          }

          if (!recursive || !block.has_children || depth >= maxDepth) {
            continue;
          }
          // 컨테이너가 아닌 블록은 child_page를 품을 수 없으므로 내려가지 않습니다.
          if (!TRAVERSABLE_BLOCK_TYPES.has(block.type)) {
            continue;
          }

          next.push({ blockId: normalizeNotionId(block.id), depth });
        }
      }

      frontier = next;
    }

    emit({
      rootPageId: normalizedRoot,
      recursive,
      maxDepth,
      deep: deep || undefined,
      count: childPages.length,
      // limit에 걸려 잘렸다면 조용히 넘기지 않고 알려줍니다.
      truncated: childPages.length >= limit || undefined,
      childPages,
    });
  } catch (err) {
    handleNotionError(err, `Page or block not found during traversal: ${err.message}`);
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
                                        to_do, quote, code, callout, toggle, divider
                                        Optional per block: color, icon (callout),
                                        language (code), children (toggle/callout)
  --after <block-id>                    Insert right after this block instead of at the end

Global output options (any command):
  --pretty                              Indent JSON output (default: compact, one line)
  --verbose-fields                      Keep null/default fields and raw property shapes
  --no-ids                              Omit ids and urls (read-only inspection)

Options for --update-block:
  --text "new text"                     Update block text content
  --checked true|false                  Set checked state (for to_do blocks)

Options for --query-database:
  --limit <number>                      Limit results (default: 10; paginates past 100)
  --auto-expand                         Auto-fetch content blocks for each item
  --filter '<JSON>'                     Server-side filter, e.g.
                                        '{"property":"Status","select":{"equals":"Done"}}'
  --sorts '<JSON>'                      Server-side sort, e.g.
                                        '[{"property":"Due","direction":"ascending"}]'
  --properties Name,Status              Fetch only these properties (server-side projection)

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
  --max-depth <number>                  Max traversal depth (default: 3)
  --deep                                Also descend into discovered child pages
  --limit <number>                      Max discovered child pages (default: 200)

Options for --create-table:
  --columns <number>                    Number of columns (required if --headers omitted)
  --headers '<JSON>'                    Header row values, e.g. ["Name","Status"]
  --rows '<JSON>'                       Additional rows, e.g. [["a","b"],["c","d"]]
  --after <block-id>                    Insert right after this block instead of at the end
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
  node notion-api-cli.js --query-database 0d5af387f61183a5b4618142b86338a5 --filter '{"property":"Status","select":{"equals":"Done"}}' --properties Name,Status
  node notion-api-cli.js --query-database 0d5af387f61183a5b4618142b86338a5 --limit 300 --no-ids

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

// 전역 플래그는 커맨드 분기에 들어가기 전에 한 번에 걷어냅니다.
// 각 분기의 인자 루프가 모르는 플래그를 만나 오작동하지 않도록 하기 위함입니다.
function extractGlobalFlags(args) {
  const rest = [];

  for (const arg of args) {
    switch (arg) {
      case '--pretty':
        OUTPUT.pretty = true;
        break;
      case '--verbose-fields':
        OUTPUT.verboseFields = true;
        break;
      case '--no-ids':
        OUTPUT.includeIds = false;
        break;
      default:
        rest.push(arg);
    }
  }

  return rest;
}

async function main() {
  const args = extractGlobalFlags(process.argv.slice(2));

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
      let maxDepth = 3;
      let deep = false;

      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--direct-only') {
          recursive = false;
        } else if (args[i] === '--deep') {
          deep = true;
        } else if (args[i] === '--max-depth' && args[i + 1]) {
          maxDepth = parseInt(args[++i], 10);
          if (isNaN(maxDepth) || maxDepth < 1) {
            die('--max-depth must be a positive number');
          }
        } else if (args[i] === '--limit' && args[i + 1]) {
          limit = parseInt(args[++i], 10);
          if (isNaN(limit) || limit < 1) {
            die('--limit must be a positive number');
          }
        }
      }

      await findChildPages(notion, pageId, recursive, limit, maxDepth, deep);
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
      let tableAfter = null;

      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--after' && args[i + 1]) {
          tableAfter = args[++i];
        } else if (args[i] === '--columns' && args[i + 1]) {
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

      await createTable(notion, pageId, columns, headers, rows, hasColumnHeader, hasRowHeader, tableAfter);
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
      let after = null;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--blocks' && args[i + 1]) {
          blocksJson = args[++i];
        } else if (args[i] === '--after' && args[i + 1]) {
          after = args[++i];
        }
      }

      if (!blocksJson) {
        die('--append-blocks requires --blocks option with JSON array');
      }

      await appendBlocks(notion, pageId, blocksJson, after);
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
      const queryOptions = {};

      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--limit' && args[i + 1]) {
          limit = parseInt(args[++i], 10);
          if (isNaN(limit) || limit < 1) {
            die('--limit must be a positive number');
          }
        } else if (args[i] === '--auto-expand') {
          autoExpand = true;
        } else if (args[i] === '--filter' && args[i + 1]) {
          queryOptions.filter = parseJsonOption(args[++i], 'filter');
        } else if (args[i] === '--sorts' && args[i + 1]) {
          queryOptions.sorts = parseJsonOption(args[++i], 'sorts');
          if (!Array.isArray(queryOptions.sorts)) {
            die('--sorts must be a JSON array');
          }
        } else if (args[i] === '--properties' && args[i + 1]) {
          queryOptions.properties = args[++i]
            .split(',')
            .map(name => name.trim())
            .filter(Boolean);
          if (queryOptions.properties.length === 0) {
            die('--properties requires at least one property name');
          }
        }
      }

      await queryDatabase(notion, databaseId, limit, autoExpand, queryOptions);
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

// 직접 실행할 때만 CLI로 동작하고, require될 때는 내부 함수를 노출합니다.
// 토큰 없이도 포매터·페이지네이션·순회 로직을 테스트할 수 있게 하기 위함입니다.
if (require.main === module) {
  main();
} else {
  module.exports = {
    OUTPUT,
    prune,
    mapWithConcurrency,
    extractPageIdFromUrl,
    formatPropertyValue,
    formatBlockContent,
    formatPageOutput,
    formatDatabaseOutput,
    formatQueryResults,
    formatSearchItem,
    normalizePageSummary,
    extractTitleFromPage,
    fetchDatabaseRows,
    listTableRows,
    listChildBlocks,
    findChildPages,
    TRAVERSABLE_BLOCK_TYPES,
  };
}
