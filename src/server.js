const { createApp } = require('./app');
const { startFollowupScheduler } = require('./followup');

const { app, ctx } = createApp();
startFollowupScheduler(ctx);

app.listen(ctx.config.port, () => {
  console.log(`Recruitment portal running at ${ctx.config.appUrl}`);
  console.log(`WhatsApp: ${ctx.whatsapp.configured ? 'live' : 'console (dev)'} | Push: ${ctx.push.configured ? 'live' : 'console (dev)'}`);
});
