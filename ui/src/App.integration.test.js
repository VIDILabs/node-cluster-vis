/**
 * End-to-end check against a running backend.
 *
 * Skipped unless NCV_TEST_API points at a live server, so `npm test` stays
 * offline by default:
 *
 *   NCV_TEST_API=http://127.0.0.1:5010 npm test -- --watchAll=false
 */
import { render, screen, waitFor } from '@testing-library/react';

const API = process.env.NCV_TEST_API;
const maybe = API ? describe : describe.skip;

maybe('App against a live API', () => {
  let App;

  beforeAll(async () => {
    process.env.REACT_APP_API_BASE = API;
    // jsdom ships no fetch; hand the app Node's real one so requests hit the
    // server instead of being stubbed.
    global.fetch = fetch;
    App = (await import('./App')).default;
  });

  test('loads a dataset and renders every panel', async () => {
    render(<App />);

    // Panels only lose their placeholder once real data has arrived.
    await waitFor(
      () => {
        expect(screen.getByText(/TIME DOMAIN VIEW/i)).toBeInTheDocument();
        expect(screen.getByText(/NODE SIMILARITY VIEW/i)).toBeInTheDocument();
        expect(screen.getByText(/METRIC READING VIEW/i)).toBeInTheDocument();
        expect(screen.getByText(/NODE BEHAVIOR VIEW/i)).toBeInTheDocument();
      },
      { timeout: 60000 }
    );

    // A node count only renders once the DR response has been applied.
    await waitFor(() => {
      expect(screen.getByText(/Nodes: [1-9]/)).toBeInTheDocument();
      expect(screen.getByText(/Metrics: [1-9]/)).toBeInTheDocument();
    }, { timeout: 60000 });

    expect(screen.queryByText(/Cannot reach the API/i)).not.toBeInTheDocument();
  }, 120000);
});
