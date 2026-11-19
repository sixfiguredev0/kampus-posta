export default {
  agentRules: false,
  devIndicators: false,
  allowedDevOrigins: ['tusmail.localhost'],
  outputFileTracingExcludes: { '/*': ['./.mail-data/**', './.env*'] },
  // sanitize-html stays bundled: as an external its CommonJS entry require()s ESM-only htmlparser2, which crashes on Vercel.
  serverExternalPackages: ['imapflow', 'nodemailer', 'mailparser', 'pg'],
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
      ],
    }];
  },
};
