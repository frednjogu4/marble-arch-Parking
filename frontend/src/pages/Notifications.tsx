import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, get, post, fmtDT, errMsg } from '../api';
import { useToast, Badge, Empty, CenterSpin } from '../ui';

export default function Notifications() {
  const toast = useToast();
  const [n, setN] = useState<any>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setN(await get('/api/notifications'));
    } catch (e: any) {
      setError(e instanceof ApiError && e.status === 404
        ? 'The connected API does not provide notifications. Ask your administrator to connect the correct parking backend.'
        : errMsg(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const mark = async (id: any) => {
    try {
      await post(`/api/notifications/${id}/read`);
      load();
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };
  const markAll = async () => {
    try {
      await post('/api/notifications/read-all');
      load();
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  if (!n && loading) return <CenterSpin />;
  if (!n) return (
    <div className="page">
      <div className="card" role="alert">
        <h2>Notifications unavailable</h2>
        <p>{error || 'Could not load notifications.'}</p>
        <button className="btn" onClick={load}>Try again</button>
      </div>
    </div>
  );

  return (
    <div className="page">
      {error && <div className="alert alert-err" role="alert">{error} <button className="link" onClick={load}>Try again</button></div>}
      <div className="page-head">
        <h2>Notifications ({n.unread} unread)</h2>
        <button className="btn btn-sm" onClick={markAll}>Mark all read</button>
      </div>
      {n.alerts?.length > 0 && (
        <div className="card">
          <h3>⚠️ Subscription alerts</h3>
          {n.alerts.map((a: any) => (
            <div key={a.id} className="notif-row">
              <div><b>{a.title}</b><div className="muted">{a.message}</div></div>
              <Link className="btn btn-sm" to={a.link}>Open</Link>
            </div>
          ))}
        </div>
      )}
      <div className="card">
        <h3>System notifications</h3>
        {n.stored?.length === 0 && <Empty title="No notifications" />}
        {n.stored?.map((x: any) => (
          <div key={x.id} className={`notif-row ${x.read_at ? 'read' : ''}`}>
            <div>
              <b>{x.title}</b> {!x.read_at && <Badge tone="warn">new</Badge>}
              <div className="muted">{x.message}</div>
              <div className="muted">{fmtDT(x.created_at)} · {x.type}</div>
            </div>
            <span>
              {x.link && <Link className="btn btn-sm" to={x.link}>Open</Link>}
              {' '}{!x.read_at && <button className="btn btn-sm" onClick={() => mark(x.id)}>Mark read</button>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
