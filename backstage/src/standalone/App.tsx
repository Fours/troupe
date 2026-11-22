import { useMemo, useState } from 'react';
import { httpClient, type ConnectionStatus } from '../http-client.ts';
import { Backstage } from '../ui/Backstage.tsx';

const STATUS: Record<ConnectionStatus, string> = {
  connecting: 'Connecting…',
  open: 'Live',
  reconnecting: 'The system has gone away. Reconnecting…',
  closed: 'The server refused the connection. Reload to try again.',
};

/** Backstage on its own, for the system that served the page. */
export function App() {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  // The page's own folder, so it works behind a path prefix too.
  const client = useMemo(() => httpClient(new URL('.', location.href), setStatus), []);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  return (
    <main>
      <header className="bar">
        <h1>Backstage</h1>
        <p role="status" className={`status status-${status}`}>
          {STATUS[status]}
        </p>
      </header>
      <Backstage client={client} selected={selected} onSelect={setSelected} />
    </main>
  );
}
