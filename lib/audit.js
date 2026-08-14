'use strict';

const MAX_AUDIT_LOGS = 500;

function normalizeAuditLogs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object' && typeof item.action === 'string')
    .slice(0, MAX_AUDIT_LOGS)
    .map((item) => ({
      id: String(item.id || ''),
      at: Number(item.at) || Date.now(),
      actorId: String(item.actorId || ''),
      actorName: String(item.actorName || ''),
      action: String(item.action || ''),
      target: String(item.target || ''),
      details: String(item.details || '')
    }));
}

function appendAuditLog(logs, entry) {
  const list = Array.isArray(logs) ? logs : [];
  const item = {
    id: String(entry.id || ''),
    at: Number(entry.at) || Date.now(),
    actorId: String(entry.actorId || ''),
    actorName: String(entry.actorName || ''),
    action: String(entry.action || ''),
    target: String(entry.target || ''),
    details: String(entry.details || '')
  };
  list.unshift(item);
  if (list.length > MAX_AUDIT_LOGS) list.length = MAX_AUDIT_LOGS;
  return item;
}

module.exports = { MAX_AUDIT_LOGS, normalizeAuditLogs, appendAuditLog };
