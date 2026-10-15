import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';
import env from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';
import { cfRayDiagnostic } from './middleware/cfRayDiagnostic.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { command2aRouter } from './routes/command2a.js';
import { communitiesRouter } from './routes/communities.js';
import { creatorBusinessMarketplaceRouter } from './routes/creatorBusinessMarketplace.js';
import { healthRouter } from './routes/health.js';
import { messagesRouter } from './routes/messages.js';
import { mediaRouter } from './routes/media.js';
import { paymentsRouter } from './routes/payments.js';
import { socialRouter } from './routes/social.js';
import { subscriptionRouter } from './routes/subscriptions.js';

const app = express();
app.set('trust proxy', 1);
const testRuntime = env.NODE_ENV === 'test' || process.env.VITEST === 'true';
const allowedOrigins = Array.from(
  new Set([
    ...env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean),
    'https://nova-social-platform-svx2.vercel.app',
    'https://nova-social-platform.vercel.app',
  ]),
);
const connectSources = [
  "'self'",
  ...allowedOrigins.filter((origin) => origin !== '*'),
  ...(env.LIVEKIT_URL ? [env.LIVEKIT_URL] : []),
];

app.use(cfRayDiagnostic);
app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: connectSources,
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
}));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Origin not allowed by CORS policy.'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
if (env.NODE_ENV === 'production') {
  app.use(morgan((tokens, req, res) => JSON.stringify({
      event: 'http_request',
      method: tokens.method(req, res),
      path: req.path,
      status: Number(tokens.status(req, res)),
      durationMs: Number(tokens['response-time'](req, res)),
    })));
} else {
  app.use(morgan('dev'));
}

const apiRateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => testRuntime,
  message: { message: 'Too many requests. Please try again later.' },
});

const authRateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => testRuntime,
  message: { message: 'Too many authentication attempts. Please try again later.' },
});

app.use('/api', apiRateLimiter);
app.use('/api/auth', authRateLimiter);
app.use('/health', healthRouter);
app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/media', mediaRouter);
app.use('/api/admin', adminRouter);
app.use('/api', messagesRouter);
app.use('/api', communitiesRouter);
app.use('/api', paymentsRouter);
app.use('/api', subscriptionRouter);
app.use('/api', socialRouter);
app.use('/api', command2aRouter);
app.use('/api', creatorBusinessMarketplaceRouter);

app.get('/', (_req, res) => {
  res.json({ name: 'NOVA Social Platform API', status: 'online' });
});

app.use((_req, res) => {
  res.status(404).json({ message: 'Route not found.' });
});

app.use(errorHandler);

export { app };
