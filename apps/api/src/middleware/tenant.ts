import { Response, NextFunction } from 'express';
import { pool } from '../db';
import { AuthRequest } from './auth';
import { isUuid } from '../utils';

export const requireRole = (allowedRoles: string[]) => {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    }

    const teamId = req.params.teamId;
    if (!teamId) {
      return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Team ID is required' } });
    }
    if (!isUuid(teamId)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid team ID' } });
    }

    try {
      const { rows } = await pool.query(
        'SELECT role FROM team_memberships WHERE user_id = $1 AND team_id = $2',
        [req.user.id, teamId]
      );

      if (rows.length === 0) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Team not found' } });
      }

      const userRole = rows[0].role;
      if (!allowedRoles.includes(userRole)) {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};
