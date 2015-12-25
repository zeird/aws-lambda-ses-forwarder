console.log('AWS Lambda SES Forwarder // @zeird // Version 1.1.0');

// Configure the S3 bucket and key prefix for stored raw emails, and the
// mapping of email addresses to forward from and to.
//
// Expected keys/values:
// - emailBucket: S3 bucket name where SES stores emails.
// - emailKeyPrefix: S3 key name prefix where SES stores email. Include the
//   trailing slash.
// - forwardMapping: Object where the key is the email address from which to
//   forward and the value is an array of email addresses or a single string
//   with email address to which to send the message.
var config = {
    'emailBucket': 's3-bucket-name',
    'emailKeyPrefix': 'emailsPrefix/',
    'forwardMapping': {
        'info@example.com': [
            'example.john@example.com',
            'example.jen@example.com'
        ],
        'abuse@example.com': 'example.jim@example.com'
    }
};

var aws = require('aws-sdk');
var ses = new aws.SES();
var s3 = new aws.S3();

exports.handler = function (aEvent, aContext) {
    // Validate characteristics of a SES event record.
    if (!aEvent.Records ||
         aEvent.Records.length !== 1 ||
         aEvent.Records[0].eventSource !== 'aws:ses' ||
         aEvent.Records[0].eventVersion !== '1.0'
    ) {
        return aContext.fail('Error: Expecting event with source aws:ses and version 1.0, but received: ' + JSON.stringify(aEvent));
    }

    var recipients = aEvent.Records[0].ses.receipt.recipients;
    console.log('Origin recipients:', recipients.join(', '));

    // Determine new recipients
    var forwardRecipients = [], fm = config.forwardMapping;
    for (var i = 0, len = recipients.length; i < len; i++) {
        forwardRecipients = forwardRecipients.concat(fm[recipients[i]] || []);
    }
    console.log('Forward recipients:', forwardRecipients.join(', '));

    // Loadind raw email from S3
    var email = aEvent.Records[0].ses.mail;
    console.log('Loading email s3://' + config.emailBucket + '/' + config.emailKeyPrefix + email.messageId + '...');
    s3.getObject({
        Bucket: config.emailBucket,
        Key: config.emailKeyPrefix + email.messageId
    }, function (aErr, aData) {
        if (aErr) {
            console.log(aErr, aErr.stack);
            return aContext.fail('Error: Failed to load message body from S3: ' + aErr);
        }

        // SES does not allow sending messages from an unverified address,
        // so the message's "From:", "Sender:" and "Return-Path:" headers are
        // replaced the original recipient (which is a verified domain) and
        // any "Reply-To:" header is replaced with the original sender.
        var rawEmail = {
            Destinations: forwardRecipients,
            Source: recipients[0],
            RawMessage: {
                Data: aData.Body.toString()
                    .replace(/^Return-Path: .*/m, 'Return-Path: <' + recipients[0] + '>')
                    .replace(/^Sender: .*/m, 'Sender: ' + recipients[0])
                    .replace(/^Reply-To: (.*)/m, '')
                    .replace(/^From: (.*)/m, function (aMatch, aFrom) {
                        return 'From: ' + (
                            /<(?=([^>]+))\1>/.test(aFrom) ? aFrom.replace(/<[^>]+>/, '<' + recipients[0] + '>') : recipients[0]
                        ) + '\r\nReply-To: ' + email.source;
                    })
            }
        };

        // Send email using the SES sendRawEmail command
        console.log('Email body is alterer and about to be send.');
        ses.sendRawEmail(rawEmail, function (aErr, aData) {
            if (aErr) {
                console.log(aErr, aErr.stack);
                console.log('Failed to be sent message:\n' + JSON.stringify(rawEmail, null, '    '));
                aContext.fail('Error: Email sending failed.');
            } else {
                console.log(aData);
                aContext.succeed('Email has been successfully forwarded for ' + recipients.join(', ') + ' to ' + forwardRecipients.join(', '));
            }
        });
    });
};
