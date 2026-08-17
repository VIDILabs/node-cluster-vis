import { render, screen, waitFor } from '@testing-library/react';
import App from './App';

// The dashboard is API-driven, so the only thing worth asserting without a
// backend is that it renders its shell and surfaces a reachable error instead of
// crashing when the server is absent.
describe('App', () => {
  beforeEach(() => {
    global.fetch = jest.fn(() => Promise.reject(new Error('connection refused')));
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  test('renders the dashboard title', () => {
    render(<App />);
    expect(
      screen.getByText(/Cluster-Based Multivariate Time Series Analysis/i)
    ).toBeInTheDocument();
  });

  test('surfaces an error when the API is unreachable', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Cannot reach the API/i)).toBeInTheDocument();
    });
  });
});
