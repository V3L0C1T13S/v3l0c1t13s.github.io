# WEBrick 1.9.2 treats a matching If-Range as a cache hit (304), which
# prevents browsers from resuming partially buffered videos in local previews.
require "webrick"
require "webrick/httpservlet/filehandler"

module PreviewIfRange
  def do_GET(req, res)
    validator = req.header.delete("if-range")
    range = nil

    if validator && req["range"]
      stat = File.stat(@local_path)
      etag = format("%x-%x-%x", stat.ino, stat.size, stat.mtime.to_i)
      value = validator.first
      matches = value == etag || value == %Q("#{etag}")
      unless matches
        begin
          matches = Time.httpdate(value).to_i >= stat.mtime.to_i
        rescue ArgumentError
          matches = false
        end
      end
      # A stale validator requires the complete current file, not a range.
      range = req.header.delete("range") unless matches
    end

    super
  ensure
    req.header["if-range"] = validator if validator
    req.header["range"] = range if range
  end
end

if WEBrick::VERSION == "1.9.2"
  WEBrick::HTTPServlet::DefaultFileHandler.prepend(PreviewIfRange)
end
