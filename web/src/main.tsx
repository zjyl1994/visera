import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { CssBaseline, ThemeProvider, createTheme, useMediaQuery } from '@mui/material'
import App from './App'
import './styles.css'

const createAppTheme = (dark: boolean) => createTheme({
  palette: {
    mode: dark ? 'dark' : 'light',
    primary: { main: dark ? '#0a84ff' : '#007aff', contrastText: '#ffffff' },
    secondary: { main: dark ? '#30d158' : '#34c759' },
    background: { default: dark ? '#1c1c1e' : '#f2f2f7', paper: dark ? '#2c2c2e' : '#ffffff' },
    text: { primary: dark ? '#f5f5f7' : '#1d1d1f', secondary: dark ? '#98989d' : '#6e6e73' },
    divider: dark ? 'rgba(235, 235, 245, .18)' : 'rgba(60, 60, 67, .18)',
    error: { main: dark ? '#ff453a' : '#ff3b30' },
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    h4: { fontSize: 'clamp(1.65rem, 2.5vw, 2.15rem)', fontWeight: 700, letterSpacing: '-.035em' },
    h6: { fontWeight: 700, letterSpacing: '-.02em' },
    button: { fontWeight: 650, letterSpacing: 0, textTransform: 'none' },
  },
  components: {
    MuiButton: { styleOverrides: { root: { minHeight: 40, borderRadius: 10 }, contained: { boxShadow: 'none' } } },
    MuiIconButton: { styleOverrides: { root: { minWidth: 40, minHeight: 40 } } },
    MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
    MuiTextField: { defaultProps: { size: 'small' } },
  },
})
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 } } })

function Root() {
  const dark = useMediaQuery('(prefers-color-scheme: dark)')
  return <ThemeProvider theme={createAppTheme(dark)}><CssBaseline /><App /></ThemeProvider>
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><BrowserRouter><QueryClientProvider client={queryClient}><Root /></QueryClientProvider></BrowserRouter></React.StrictMode>,
)
