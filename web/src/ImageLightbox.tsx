import Lightbox from 'yet-another-react-lightbox'
import Captions from 'yet-another-react-lightbox/plugins/captions'
import DownloadPlugin from 'yet-another-react-lightbox/plugins/download'
import Zoom from 'yet-another-react-lightbox/plugins/zoom'
import 'yet-another-react-lightbox/styles.css'
import 'yet-another-react-lightbox/plugins/captions.css'

export default function ImageLightbox({ open, onClose, src, alt, downloadURL, title, description }: { open: boolean; onClose: () => void; src: string; alt: string; downloadURL?: string; title?: string; description?: string }) {
  return <Lightbox open={open} close={onClose} slides={[{ src, alt, download: downloadURL, title, description }]} plugins={[Zoom, DownloadPlugin, Captions]} carousel={{ finite: true }} controller={{ closeOnBackdropClick: true }} />
}
