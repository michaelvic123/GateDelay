const winston = require("winston");
const AuditLog = require("../models/AuditLog");

// ── Winston logger ───────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
    new winston.transports.File({ filename: "logs/audit-error.log", level: "error" }),
    new winston.transports.File({ filename: "logs/audit-combined.log" }),
  ],
});

// ── Core log function ────────────────────────────────────────────────────────
async function logOperation(params) {
  const {
    action,
    category,
    userId = null,
    userRole = null,
    resourceType = null,
    resourceId = null,
    status = "SUCCESS",
    ipAddress = null,
    userAgent = null,
    requestMethod = null,
    requestPath = null,
    details = {},
    errorMessage = null,
    duration = null,
  } = params;

  const entry = {
    action,
    category,
    userId,
    userRole,
    resourceType,
    resourceId,
    status,
    ipAddress,
    userAgent,
    requestMethod,
    requestPath,
    details,
    errorMessage,
    duration,
    timestamp: new Date(),
  };

  // Always write to winston (works even without DB)
  logger.info("AUDIT", entry);

  // Persist to MongoDB when available
  try {
    await AuditLog.create(entry);
  } catch (err) {
    logger.error("Failed to persist audit log", { error: err.message, entry });
  }

  return entry;
}

// ── Convenience wrappers ─────────────────────────────────────────────────────
function logUserAction(userId, action, details = {}, req = {}) {
  return logOperation({
    action,
    category: "USER",
    userId,
    status: "SUCCESS",
    ipAddress: req.ip || null,
    userAgent: (req.headers && req.headers["user-agent"]) || null,
    requestMethod: req.method || null,
    requestPath: req.path || null,
    details,
  });
}

function logSystemOperation(action, details = {}, status = "SUCCESS") {
  return logOperation({ action, category: "SYSTEM", status, details });
}

function logAuthEvent(userId, action, status, details = {}, req = {}) {
  return logOperation({
    action,
    category: "AUTH",
    userId,
    status,
    ipAddress: req.ip || null,
    userAgent: (req.headers && req.headers["user-agent"]) || null,
    requestMethod: req.method || null,
    requestPath: req.path || null,
    details,
  });
}

// ── Query helpers ────────────────────────────────────────────────────────────
async function queryAuditLogs(filters = {}, options = {}) {
  const {
    userId,
    category,
    action,
    status,
    resourceType,
    resourceId,
    startDate,
    endDate,
  } = filters;

  const { page = 1, limit = 50, sortBy = "timestamp", sortOrder = -1 } = options;

  const query = {};
  if (userId) query.userId = userId;
  if (category) query.category = category;
  if (action) query.action = new RegExp(action, "i");
  if (status) query.status = status;
  if (resourceType) query.resourceType = resourceType;
  if (resourceId) query.resourceId = resourceId;
  if (startDate || endDate) {
    query.timestamp = {};
    if (startDate) query.timestamp.$gte = new Date(startDate);
    if (endDate) query.timestamp.$lte = new Date(endDate);
  }

  const skip = (page - 1) * limit;
  const sort = { [sortBy]: sortOrder };

  const [logs, total] = await Promise.all([
    AuditLog.find(query).sort(sort).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(query),
  ]);

  return {
    logs,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

async function getAuditLogById(id) {
  return AuditLog.findById(id).lean();
}

// ── Export helpers ───────────────────────────────────────────────────────────
async function exportAuditLogs(filters = {}, format = "json") {
  const { logs } = await queryAuditLogs(filters, { page: 1, limit: 10000 });

  if (format === "csv") {
    const headers = [
      "timestamp","action","category","userId","userRole","status",
      "ipAddress","requestMethod","requestPath","resourceType","resourceId","errorMessage"
    ].join(",");

    const rows = logs.map((l) =>
      [
        l.timestamp,
        l.action,
        l.category,
        l.userId || "",
        l.userRole || "",
        l.status,
        l.ipAddress || "",
        l.requestMethod || "",
        l.requestPath || "",
        l.resourceType || "",
        l.resourceId || "",
        (l.errorMessage || "").replace(/,/g, ";"),
      ].join(",")
    );

    return [headers, ...rows].join("\n");
  }

  return JSON.stringify(logs, null, 2);
}

// ── Analytics ────────────────────────────────────────────────────────────────
async function getAuditAnalytics(startDate, endDate) {
  const matchStage = {};
  if (startDate || endDate) {
    matchStage.timestamp = {};
    if (startDate) matchStage.timestamp.$gte = new Date(startDate);
    if (endDate) matchStage.timestamp.$lte = new Date(endDate);
  }

  const [totalLogs, byCategory, byStatus, topActions, activeUsers] = await Promise.all([
    AuditLog.countDocuments(matchStage),

    AuditLog.aggregate([
      { $match: matchStage },
      { $group: { _id: "$category", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),

    AuditLog.aggregate([
      { $match: matchStage },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),

    AuditLog.aggregate([
      { $match: matchStage },
      { $group: { _id: "$action", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),

    AuditLog.aggregate([
      { $match: { ...matchStage, userId: { $ne: null } } },
      { $group: { _id: "$userId", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
  ]);

  const successCount = (byStatus.find((s) => s._id === "SUCCESS") || { count: 0 }).count;
  const failureCount = (byStatus.find((s) => s._id === "FAILURE") || { count: 0 }).count;

  return {
    summary: {
      totalLogs,
      successRate: totalLogs ? ((successCount / totalLogs) * 100).toFixed(2) + "%" : "0%",
      failureRate: totalLogs ? ((failureCount / totalLogs) * 100).toFixed(2) + "%" : "0%",
    },
    byCategory,
    byStatus,
    topActions,
    activeUsers,
  };
}

// ── Express middleware ────────────────────────────────────────────────────────
function auditMiddleware(category = "SYSTEM") {
  return (req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const status = res.statusCode < 400 ? "SUCCESS" : "FAILURE";
      logOperation({
        action: `${req.method} ${req.path}`,
        category,
        userId: req.user ? req.user.id : null,
        userRole: req.user ? req.user.role : null,
        status,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
        requestMethod: req.method,
        requestPath: req.path,
        duration: Date.now() - start,
        details: { statusCode: res.statusCode },
      });
    });
    next();
  };
}

module.exports = {
  logOperation,
  logUserAction,
  logSystemOperation,
  logAuthEvent,
  queryAuditLogs,
  getAuditLogById,
  exportAuditLogs,
  getAuditAnalytics,
  auditMiddleware,
  logger,
};
