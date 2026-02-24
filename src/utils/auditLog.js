import { query } from '../db/index.js';
import logger from './logger.js';

/**
 * Log an audit event for sensitive operations
 * @param {number} userId - User ID performing the action
 * @param {string} action - Action name (e.g., 'LOGIN', 'CREATE_ALERT', 'CHANGE_PASSWORD')
 * @param {string} resource - Resource type (e.g., 'user', 'alert', 'subscription')
 * @param {number} resourceId - ID of the resource being acted upon
 * @param {object} options - Additional options
 * @param {object} options.details - Additional JSON details about the action
 * @param {string} options.ipAddress - Client IP address
 * @param {string} options.userAgent - Client user agent
 * @param {string} options.status - 'success' or 'failure'
 * @param {string} options.errorMessage - Error message if status is failure
 */
export async function auditLog(userId, action, resource, resourceId = null, options = {}) {
  try {
    const {
      details = {},
      ipAddress = null,
      userAgent = null,
      status = 'success',
      errorMessage = null
    } = options;

    await query(
      `INSERT INTO audit_logs 
       (user_id, action, resource, resource_id, details, ip_address, user_agent, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        userId,
        action,
        resource,
        resourceId,
        JSON.stringify(details),
        ipAddress,
        userAgent,
        status,
        errorMessage
      ]
    );
  } catch (err) {
    logger.error('Failed to log audit event:', err);
    // Don't throw - audit logging should never break the application
  }
}

/**
 * Create middleware to automatically extract and attach request context
 * Usage: app.use(auditContext())
 */
export function auditContext() {
  return (req, res, next) => {
    req.auditContext = {
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get('user-agent'),
      userId: req.user?.userId || null
    };
    next();
  };
}

/**
 * Convenience wrapper for audit logging from routes
 * Usage: auditAction(req, 'UPDATE_PASSWORD', 'user', userId, { details: {...} })
 */
export async function auditAction(req, action, resource, resourceId = null, details = {}) {
  return auditLog(
    req.auditContext?.userId || req.user?.userId,
    action,
    resource,
    resourceId,
    {
      details,
      ipAddress: req.auditContext?.ipAddress,
      userAgent: req.auditContext?.userAgent
    }
  );
}

export default auditLog;
