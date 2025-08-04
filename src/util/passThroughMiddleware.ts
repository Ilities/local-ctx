import express from 'express';

export const passThroughMiddleware = (
  _: express.Request,
  __: express.Response,
  next: express.NextFunction
) => {
  next();
};
