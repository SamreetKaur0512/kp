export const createCloudinaryStorage = cloudinary => ({
  _handleFile(_req, file, callback) {
    const resourceType = file.mimetype.startsWith('video/') ? 'video' : 'image';
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'karan-patel-roleplay/fan-chat', resource_type: resourceType },
      (error, result) => {
        if (error) return callback(error);
        callback(null, { filename: result.public_id, path: result.secure_url, size: result.bytes, resourceType });
      },
    );
    file.stream.pipe(stream);
  },
  _removeFile(_req, file, callback) {
    cloudinary.uploader.destroy(file.filename, { resource_type: file.resourceType, invalidate: true })
      .then(() => callback(null), callback);
  },
});
