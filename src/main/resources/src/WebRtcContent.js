/**
 * @constructor WebRtcContent
 *
 * @param {String} url: URL of the WebRTC endpoint server.
 * @param {Object} options: optional configuration parameters
 *   {Enum('inactive', 'sendonly', 'recvonly', 'sendrecv')} audio: audio stream mode
 *   {Enum('inactive', 'sendonly', 'recvonly', 'sendrecv')} video: video stream mode
 *   {[Object]} iceServers: array of objects to initialize the ICE servers. It
 *     structure is the same as an Array of WebRTC RTCIceServer objects.
 *
 * @throws RangeError
 */
function WebRtcContent(url, options)
{
  var self = this;


  // Initialize options and object status

  options = options || {};

  /**
   * Decode the mode of the streams
   *
   * @private
   *
   * @param {Object} options: constraints to update and decode
   * @param {String} type: name of the constraints to decode
   *
   * @returns {Object}
   *
   * @throws RangeError
   */
  function decodeMode(options, type)
  {
    var result = {};

    // If not defined, set send & receive by default
    options[type] = options[type] || 'sendrecv';

    switch(mode)
    {
      case 'sendrecv':
        result.local  = true;
        result.remote = true;
      break;

      case 'sendonly':
        result.local  = true;
        result.remote = false;
      break;

      case 'recvonly':
        result.local  = false;
        result.remote = true;
      break;

      case 'inactive':
        result.local  = false;
        result.remote = false;
      break;

      default:
        throw new RangeError("Invalid "+type+" media mode");
    }

    return result;
  }

  // We can't disable both audio and video on a stream, raise error
  if(options.audio == 'inactive' && options.video == 'inactive')
    throw new RangeError("At least one audio or video must to be enabled");

  // Audio media
  var audio = decodeMode(options, "audio");

  // Video media
  var video = decodeMode(options, "video");


  // Init the WebRtcContent object

  $.jsonRPC.setup({endPoint: url});

  var sessionId = null;
  var pollingTimeout = null;


  // Error dispatcher functions

  var _error = null;

  /**
   * Common function to dispatch the error to the user application
   *
   * @param {Error} error: error object to be dispatched
   */
  function onerror(error)
  {
    _error = error;

    self.terminate();
  };

  /**
   * Adaptor from jsonRPC errors to standard Javascript Error objects
   *
   * @param response: jsonRPC error object
   */
  function onerror_jsonrpc(response)
  {
    onerror(response.error);
  };


  // RPC calls

  var pc = null;

  // Start

  /**
   * Request a connection with the webRTC endpoint server
   *
   * @private
   *
   * @param {MediaStream || undefined} localStream: stream locally offered
   */
  function start(localStream)
  {
    // Create the PeerConnection object
    var iceServers = options.iceServers
                  || [{url: 'stun:'+'stun.l.google.com:19302'}];

    pc = new RTCPeerConnection({iceServers: iceServers});

    // Add the local stream if defined
    if(localStream)
      pc.addStream(localStream);

    // Dispatch 'close' event if signaling gets closed
    pc.onsignalingstatechange = function(event)
    {
      if(pc.signalingState == "closed")
      {
        if(_error)
        {
          if(self.onerror)
             self.onerror(_error);
        }
        else
        {
          if(self.onterminate)
             self.onterminate(new Event('terminate'));
        }
      }
    };

    var mediaConstraints =
    {
      mandatory:
      {
        OfferToReceiveAudio: audio.remote,
        OfferToReceiveVideo: video.remote
      }
    };

    pc.createOffer(function(offer)
    {
      // Set the peer local description
      pc.setLocalDescription(offer,
      function()
      {
        console.info("LocalDescription correctly set");
      },
      onerror);
    },
    onerror,
    mediaConstraints);

    pc.onicecandidate = function(event)
    {
      if(event.candidate)
        return;

      var params =
      {
        sdp: pc.localDescription.sdp,
        contrainsts:
        {
          audio: options.audio,
          video: options.video
        }
      };

      /**
       * Callback when connection is succesful
       *
       * @private
       *
       * @param {Object} response: JsonRPC response
       */
      function success(response)
      {
        var result = response.result;

        sessionId = result.sessionId;

        pc.setRemoteDescription(new RTCSessionDescription(
        {
          type: 'answer',
          sdp: result.sdp
        }),
        function()
        {
          // Init MediaEvents polling
          pollMediaEvents();

          // Local streams
          if(video.local)
          {
            var streams = pc.getLocalStreams();

            if(streams && streams[0])
            {
              var stream = streams[0];

              if(options.localVideoTag)
              {
                var localVideo = document.getElementById(options.localVideoTag);

                if(localVideo)
                   localVideo.src = URL.createObjectURL(stream);
                else
                {
                  var msg = "Requested local video tag '"+options.localVideoTag
                          + "' is not available";

                  onerror(new Error(msg));
                  return
                };
              }

              if(self.onlocalstream)
              {
                var event = new Event('localstream');
                    event.stream = stream;

                self.onlocalstream(event)
              }
            }
            else
            {
              onerror(new Error("No local streams are available"));
              return
            }
          }

          // Remote streams
          if(video.remote)
          {
            var streams = pc.getRemoteStreams();

            if(streams && streams[0])
            {
              var stream = streams[0];

              if(options.remoteVideoTag)
              {
                var remoteVideo = document.getElementById(options.remoteVideoTag);

                if(remoteVideo)
                   remoteVideo.src = URL.createObjectURL(stream);
                else
                {
                  var msg = "Requested remote video tag '"
                          + options.localVideoTag + "' is not available";

                  onerror(new Error(msg));
                  return
                };
              }

              if(self.onremotestream)
              {
                var event = new Event('remotestream');
                    event.stream = stream;

                self.onremotestream(event)
              }
            }
            else
            {
              onerror(new Error("No remote streams are available"));
              return
            }
          }

          // Notify we created the connection successfully
          if(self.onstart)
             self.onstart(new Event('start'));
        },
        onerror);
      }

      $.jsonRPC.request('start',
      {
        params:  params,
        success: success,
        error:   onerror_jsonrpc
      });
    };
  };


  /**
   * Terminate the connection with the WebRTC media server
   */
  this.terminate = function()
  {
    // Stop polling
    clearTimeout(pollingTimeout);
    pollingTimeout = 'stopped';

    // Notify to the WebRTC endpoint server
    if(sessionId)
    {
      var params =
      {
        sessionId: sessionId
      };

      $.jsonRPC.request('terminate', {params: params});
    };

    // Close the PeerConnection
    pc.close();
  };


  // Pool

  var MAX_ALLOWED_ERROR_TRIES = 10;

  var error_tries = 0;

  /**
   * Pool for events dispatched on the server pipeline
   *
   * @private
   */
  function pollMediaEvents()
  {
    var params =
    {
      sessionId: sessionId
    };

    $.jsonRPC.request('poll',
    {
      params: params,
      success: function(response)
      {
        error_tries = 0;

        var result = response.result;

        if(result.events)
          for(var i=0, data; data=result.events[i]; i++)
            if(self.onmediaevent)
            {
              var event = new Event('MediaEvent');
                  event.data = data;

              self.onmediaevent(event);
            }

        if(pollingTimeout != 'stopped')
           pollingTimeout = setTimeout(pollMediaEvents, 0);
      },
      error: function(response)
      {
        // A poll error has occurred, retry it
        if(error_tries < MAX_ALLOWED_ERROR_TRIES)
        {
          if(pollingTimeout != 'stopped')
             pollingTimeout = setTimeout(pollMediaEvents, Math.pow(2, error_tries));

          error_tries++;
        }

        // Max number of poll errors achieved, raise error
        else
    	  onerror_jsonrpc(response);
      }
    });
  }


  // Mode set to send local audio and/or video stream
  if(audio.local || video.local)
    getUserMedia({'audio': audio.local, 'video': video.local},
    function(stream)
    {
      console.log('User has granted access to local media.');

      start(stream);
    },
    onerror);

  // Mode set to only receive a stream, not send it
  else
	start();
}