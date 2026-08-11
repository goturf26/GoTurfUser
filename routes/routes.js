const express = require('express');
const router = express.Router();

router.post('/routes', async (req, res) => {
    try {
        const { origin, destination } = req.body;

        const originLatitude = Number(origin?.latitude);
const originLongitude = Number(origin?.longitude);

const destinationLatitude = Number(destination?.latitude);
const destinationLongitude = Number(destination?.longitude);

if (
    !Number.isFinite(originLatitude) ||
    !Number.isFinite(originLongitude) ||
    !Number.isFinite(destinationLatitude) ||
    !Number.isFinite(destinationLongitude)
) {
    return res.status(400).json({
        success: false,
        message: 'Invalid origin or destination'
    });
}

        const apiKey = process.env.GOOGLE_ROUTES_API_KEY;

        if (!apiKey) {
            console.error('GOOGLE_ROUTES_API_KEY is missing');

            return res.status(500).json({
                success: false,
                message: 'Routes API configuration missing'
            });
        }

        const response = await fetch(
            'https://routes.googleapis.com/directions/v2:computeRoutes',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Goog-Api-Key': apiKey,
                    'X-Goog-FieldMask':
                        'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline'
                },
                body: JSON.stringify({
                    origin: {
                        location: {
                            latLng: {
                                latitude: originLatitude,
                                longitude: originLongitude
                            }
                        }
                    },

                    destination: {
                        location: {
                            latLng: {
                                latitude: destinationLatitude,
                                longitude: destinationLongitude
                            }
                        }
                    },

                    travelMode: 'DRIVE',

                    routingPreference: 'TRAFFIC_AWARE',

                    computeAlternativeRoutes: false,

                    languageCode: 'en-US',

                    units: 'METRIC'
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            console.error('Google Routes API error:', data);

            return res.status(response.status).json({
                success: false,
                message: 'Unable to calculate route'
            });
        }

        if (!data.routes || data.routes.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No route found'
            });
        }

        const route = data.routes[0];

        res.json({
            success: true,

            distanceMeters: route.distanceMeters,

            duration: route.duration,

            polyline:
                route.polyline?.encodedPolyline || ''
        });

    } catch (error) {
        console.error('Routes API error:', error);

        res.status(500).json({
            success: false,
            message: 'Server error while calculating route'
        });
    }
});

module.exports = router;