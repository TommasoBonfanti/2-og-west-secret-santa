import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { backend } from '../api';
import { MAX_WISHLIST_IMAGES, type WishlistImage } from '../types';
import { useSessionApp } from '../components/AppContext';
import { Button, Card, Field, Loading, TextField } from '../components/ui';
import { PageTitle } from '../components/Layout';
import { Polaroid } from '../components/Polaroid';
import { useToast } from '../components/Toast';
import { isHttpUrl } from '../lib/format';
import { resizeImage, safeImageSrc } from '../lib/image';
import { hrefFor } from '../lib/router';

const MAX_TEXT = 4000;
const MAX_LINKS = 10;

export function WishlistPage() {
  const { event } = useSessionApp();
  const toast = useToast();
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState('');
  const [links, setLinks] = useState<string[]>([]);
  const [images, setImages] = useState<WishlistImage[]>([]);
  const [newLink, setNewLink] = useState('');
  const [linkError, setLinkError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const drawn = event.status === 'drawn';

  useEffect(() => {
    if (!drawn) return;
    let alive = true;
    backend
      .getMyWishlist()
      .then((w) => {
        if (!alive) return;
        if (w) {
          setText(w.text);
          setLinks(w.links);
          setImages(w.images);
        }
        setLoaded(true);
      })
      .catch((e) => {
        toast.error(e);
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [drawn, toast]);

  if (!drawn) {
    return (
      <div className="page narrow">
        <PageTitle>Your wishlist</PageTitle>
        <Card>
          <p>Wishlists open as soon as the names are drawn. Hang tight by the fire!</p>
          <a className="btn btn-secondary" href={hrefFor('home')}>
            <span>Back home</span>
          </a>
        </Card>
      </div>
    );
  }

  const addLink = () => {
    let url = newLink.trim();
    if (!url) return;
    if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;
    if (!isHttpUrl(url)) {
      setLinkError('That doesn’t look like a web link (it should start with http:// or https://).');
      return;
    }
    if (links.length >= MAX_LINKS) {
      setLinkError(`Up to ${MAX_LINKS} links.`);
      return;
    }
    setLinks((l) => [...l, url]);
    setNewLink('');
    setLinkError(undefined);
    setDirty(true);
  };

  const onFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    const room = MAX_WISHLIST_IMAGES - images.length;
    if (files.length > room) toast.info(`Only ${MAX_WISHLIST_IMAGES} pictures fit — adding the first ${Math.max(0, room)}.`);
    setProcessing(true);
    try {
      const added: WishlistImage[] = [];
      for (const f of files.slice(0, Math.max(0, room))) {
        const r = await resizeImage(f, { maxSide: 1000, maxBytes: 150_000 });
        added.push({ mime: r.mime, dataB64: r.dataB64 });
      }
      if (added.length) {
        setImages((imgs) => [...imgs, ...added].slice(0, MAX_WISHLIST_IMAGES));
        setDirty(true);
      }
    } catch (err) {
      toast.error(err);
    } finally {
      setProcessing(false);
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await backend.saveMyWishlist({ text: text.trim(), links, images });
      setDirty(false);
      toast.success('Wishlist saved and sealed. Your Secret Santa will love it.');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page narrow">
      <PageTitle sub="Only your Secret Santa can read this.">Your wishlist</PageTitle>
      {!loaded ? (
        <Card>
          <Loading label="Unsealing your wishlist…" />
        </Card>
      ) : (
        <form onSubmit={save} className="stack">
          <Card>
            <h2 className="card-title">Ideas</h2>
            <Field label="What would make you smile?" hint={`Sizes, favourite colours, things you'd love (or not). ${text.length}/${MAX_TEXT}`}>
              {({ id, describedBy }) => (
                <textarea
                  id={id}
                  className="input textarea"
                  aria-describedby={describedBy}
                  rows={6}
                  maxLength={MAX_TEXT}
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    setDirty(true);
                  }}
                  placeholder="Cozy socks (size 42), a good mystery novel, anything with 67 on it…"
                />
              )}
            </Field>
          </Card>

          <Card>
            <h2 className="card-title">Links</h2>
            {links.length > 0 && (
              <ul className="edit-links">
                {links.map((l, i) => (
                  <li key={`${l}-${i}`}>
                    <span className="edit-link-url">{l}</span>
                    <Button
                      small
                      variant="ghost"
                      aria-label={`Remove link ${l}`}
                      onClick={() => {
                        setLinks((xs) => xs.filter((_, j) => j !== i));
                        setDirty(true);
                      }}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="inline-form">
              <TextField
                label="Add a link"
                type="url"
                inputMode="url"
                placeholder="https://…"
                value={newLink}
                onChange={(e) => {
                  setNewLink(e.target.value);
                  setLinkError(undefined);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addLink();
                  }
                }}
                error={linkError}
              />
              <Button variant="secondary" onClick={addLink} disabled={!newLink.trim()}>
                Add link
              </Button>
            </div>
          </Card>

          <Card>
            <h2 className="card-title">Pictures</h2>
            <p className="muted small">
              Up to {MAX_WISHLIST_IMAGES}. They're shrunk on your device and encrypted before upload.
            </p>
            {images.length > 0 && (
              <div className="wishlist-images edit-images">
                {images.map((img, i) => {
                  const src = safeImageSrc(img.mime, img.dataB64);
                  return (
                    <div key={i} className="edit-image">
                      {src && <Polaroid src={src} alt={`Your picture ${i + 1}`} seed={`mine-${i}`} size="sm" />}
                      <Button
                        small
                        variant="ghost"
                        aria-label={`Remove picture ${i + 1}`}
                        onClick={() => {
                          setImages((xs) => xs.filter((_, j) => j !== i));
                          setDirty(true);
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="visually-hidden"
              onChange={onFiles}
              tabIndex={-1}
              aria-hidden="true"
            />
            <Button
              variant="secondary"
              busy={processing}
              disabled={images.length >= MAX_WISHLIST_IMAGES}
              onClick={() => fileRef.current?.click()}
            >
              {images.length >= MAX_WISHLIST_IMAGES ? 'That’s the maximum' : 'Add pictures'}
            </Button>
          </Card>

          <div className="sticky-save">
            <Button type="submit" busy={busy} disabled={processing} block>
              Save my wishlist
            </Button>
            {dirty && <p className="note center">You have unsaved changes.</p>}
            <p className="note center">
              <span aria-hidden="true">🔒 </span>Only your Secret Santa can read this.
            </p>
          </div>
        </form>
      )}
    </div>
  );
}
