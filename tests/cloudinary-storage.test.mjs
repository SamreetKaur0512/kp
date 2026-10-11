import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { createCloudinaryStorage } from '../cloudinary-storage.js';

test('uploads files to Cloudinary and records video resource type', async () => {
  let options;
  const fakeCloudinary = {
    uploader: {
      upload_stream(uploadOptions, callback) {
        options = uploadOptions;
        return new Writable({
          write(_chunk, _encoding, done) { done(); },
          final(done) {
            callback(null, { public_id: 'fan-chat/clip', secure_url: 'https://cdn.example/clip.mp4', bytes: 12 });
            done();
          },
        });
      },
    },
  };
  const storage = createCloudinaryStorage(fakeCloudinary);
  const file = { mimetype: 'video/mp4', stream: Readable.from(['video']) };
  const uploaded = await new Promise((resolve, reject) => {
    storage._handleFile({}, file, (error, result) => error ? reject(error) : resolve(result));
  });

  assert.equal(options.resource_type, 'video');
  assert.equal(options.folder, 'karan-patel-roleplay/fan-chat');
  assert.deepEqual(uploaded, {
    filename: 'fan-chat/clip',
    path: 'https://cdn.example/clip.mp4',
    size: 12,
    resourceType: 'video',
  });
});

test('deletes Cloudinary videos using their video resource type', async () => {
  let deleted;
  const storage = createCloudinaryStorage({
    uploader: {
      destroy: async (publicId, options) => { deleted = { publicId, options }; return { result: 'ok' }; },
    },
  });

  await new Promise((resolve, reject) => {
    storage._removeFile({}, { filename: 'fan-chat/clip', resourceType: 'video' }, error => error ? reject(error) : resolve());
  });

  assert.deepEqual(deleted, {
    publicId: 'fan-chat/clip',
    options: { resource_type: 'video', invalidate: true },
  });
});
