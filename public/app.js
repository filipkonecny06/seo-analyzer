// Browser entry point; behavior lives in importable modules so it can be tested without a server.
import { AnalyzerApp } from './analyzer-app.mjs';

new AnalyzerApp(document).init();
