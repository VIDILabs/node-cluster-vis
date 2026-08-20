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

  test('the three panels stay on one row', () => {
    const { container } = render(<App />);

    const columns = Array.from(container.querySelectorAll('.dashboard-column'));
    expect(columns).toHaveLength(3);
    // Siblings, so the row is genuinely one row rather than three that happen
    // to be adjacent.
    const row = columns[0].parentElement;
    columns.forEach((column) => expect(column.parentElement).toBe(row));

    // A flex row wraps on its items' *hypothetical* sizes — their flex-basis —
    // before any shrinking is considered. `flex="auto"` gave the reading column
    // a content-width basis, which measured wider than the space left, and the
    // embedding and the heatmap dropped onto a second line. Both halves of the
    // fix are pinned here: nothing wraps, and the reading column asks for
    // nothing up front and grows into the leftover.
    expect(row.className).toContain('ant-row-no-wrap');
    expect(columns[0].style.flex).toMatch(/^1 1 0(px)?$/);
    expect(columns[0].style.minWidth).toBeTruthy();

    // The deviation column is sized to its map, in pixels, not in 24ths.
    expect(columns[2].style.flex).toMatch(/^0 0 \d+px$/);
  });

  test('surfaces an error when the API is unreachable', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Cannot reach the API/i)).toBeInTheDocument();
    });
  });
});
