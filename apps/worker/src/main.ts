import {createFolioBoss, initializeFolioQueues} from '@folio/db';

/** Registers durable V1 queues. Handlers are installed by their feature issues; no fake processing. */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Folio worker DATABASE_URL must be explicit');
  const boss = createFolioBoss(url);
  boss.on('error', () => console.error('Folio pg-boss reported a queue failure; inspect private job diagnostics'));
  await boss.start();
  await initializeFolioQueues(boss);
  console.log('Folio job queues ready. Feature handlers are not registered yet.');
  const stop = async () => { await boss.stop(); process.exit(0); };
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
}
void main().catch(error => {console.error(error);process.exitCode = 1;});
