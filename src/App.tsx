import { useEffect, useState } from 'react'

// Placeholder page. Replace freely — this exists only to prove the
// build → deploy pipeline works end to end.
function App() {
  const [api, setApi] = useState<string>('…')

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json() as Promise<{ status: string }>)
      .then((d) => setApi(d.status))
      .catch(() => setApi('unreachable'))
  }, [])

  return (
    <main className="min-h-svh grid place-items-center bg-neutral-950 text-neutral-100 p-6">
      <div className="text-center space-y-3">
        <p className="text-sm uppercase tracking-[0.3em] text-neutral-500">commonGround</p>
        <h1 className="text-4xl font-semibold">Ready to build.</h1>
        <p className="text-neutral-400">
          Worker API: <span className="font-mono text-emerald-400">{api}</span>
        </p>
      </div>
    </main>
  )
}

export default App
