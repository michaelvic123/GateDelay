const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema(
  {
    action: { type: String, required: true, index: true },
    category: {
      type: String,
      enum: ["AUTH", "USER", "MARKET", "PREDICTION", "ADMIN", "SYSTEM"],
      required: true,
      index: true,
    },
    userId: { type: String, index: true, default: null },
    userRole: { type: String, default: null },
    resourceType: { type: String, index: true, default: null },
    resourceId: { type: String, index: true, default: null },
    status: {
      type: String,
      enum: ["SUCCESS", "FAILURE", "WARNING"],
      required: true,
      index: true,
    },
    ipAddress: { type: String, default: null },
    userAgent: { type: String, default: null },
    requestMethod: { type: String, default: null },
    requestPath: { type: String, default: null },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    errorMessage: { type: String, default: null },
    duration: { type: Number, default: null },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

auditLogSchema.index({ timestamp: -1 });
auditLogSchema.index({ userId: 1, timestamp: -1 });
auditLogSchema.index({ category: 1, timestamp: -1 });
auditLogSchema.index({ action: 1, status: 1 });

const AuditLog = mongoose.model("AuditLog", auditLogSchema);
module.exports = AuditLog;
