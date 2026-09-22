const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

/**
 * A "key stream" is a named, persistent YouTube liveStream (RTMP ingestion
 * resource). It lets a single stream's RTMP url/key stay stable across edits
 * and re-broadcasts, the same way a rotation's name doubles as its key
 * stream's title: give two streams the same "Stream Name" and they share one
 * ingestion key; leave the name off and a stream behaves as before (a fresh
 * liveStream is created every time).
 */
class StreamKey {
  static findByName(userId, channelId, name) {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM stream_keys
         WHERE user_id = ? AND name = ? COLLATE NOCASE
           AND (youtube_channel_id = ? OR (youtube_channel_id IS NULL AND ? IS NULL))`,
        [userId, name, channelId || null, channelId || null],
        (err, row) => {
          if (err) {
            console.error('Error finding stream key:', err.message);
            return reject(err);
          }
          resolve(row || null);
        }
      );
    });
  }

  static findById(id) {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM stream_keys WHERE id = ?', [id], (err, row) => {
        if (err) {
          console.error('Error finding stream key:', err.message);
          return reject(err);
        }
        resolve(row || null);
      });
    });
  }

  static findAll(userId) {
    return new Promise((resolve, reject) => {
      db.all('SELECT * FROM stream_keys WHERE user_id = ? ORDER BY name COLLATE NOCASE', [userId], (err, rows) => {
        if (err) {
          console.error('Error listing stream keys:', err.message);
          return reject(err);
        }
        resolve(rows || []);
      });
    });
  }

  static create({ userId, channelId, name, youtubeStreamId, youtubeStreamKey, youtubeRtmpUrl }) {
    const id = uuidv4();
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO stream_keys (id, user_id, youtube_channel_id, name, youtube_stream_id, youtube_stream_key, youtube_rtmp_url)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, userId, channelId || null, name, youtubeStreamId || null, youtubeStreamKey || null, youtubeRtmpUrl || null],
        function (err) {
          if (err) {
            console.error('Error creating stream key:', err.message);
            return reject(err);
          }
          resolve({ id, user_id: userId, youtube_channel_id: channelId || null, name, youtube_stream_id: youtubeStreamId, youtube_stream_key: youtubeStreamKey, youtube_rtmp_url: youtubeRtmpUrl });
        }
      );
    });
  }

  static update(id, data) {
    const fields = [];
    const values = [];
    const map = {
      youtubeStreamId: 'youtube_stream_id',
      youtubeStreamKey: 'youtube_stream_key',
      youtubeRtmpUrl: 'youtube_rtmp_url'
    };
    Object.entries(data).forEach(([key, value]) => {
      const column = map[key] || key;
      fields.push(`${column} = ?`);
      values.push(value);
    });
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);
    return new Promise((resolve, reject) => {
      db.run(`UPDATE stream_keys SET ${fields.join(', ')} WHERE id = ?`, values, function (err) {
        if (err) {
          console.error('Error updating stream key:', err.message);
          return reject(err);
        }
        resolve({ id, updated: this.changes > 0 });
      });
    });
  }

  static delete(id, userId) {
    return new Promise((resolve, reject) => {
      db.run('DELETE FROM stream_keys WHERE id = ? AND user_id = ?', [id, userId], function (err) {
        if (err) {
          console.error('Error deleting stream key:', err.message);
          return reject(err);
        }
        resolve({ success: true, deleted: this.changes > 0 });
      });
    });
  }
}

module.exports = StreamKey;
