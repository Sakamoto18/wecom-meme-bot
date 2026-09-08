import { listenMockXhs } from '../src/mock-xhs-service.js';

const port = Number(process.env.MOCK_XHS_PORT || 0);
const service = await listenMockXhs({ port });
console.log(`Mock XHS listening at ${service.baseUrl}`);
console.log(`Demo short link: ${service.baseUrl}/s/demo123`);
process.on('SIGTERM', () => service.server.close(() => process.exit(0)));
process.on('SIGINT', () => service.server.close(() => process.exit(0)));
