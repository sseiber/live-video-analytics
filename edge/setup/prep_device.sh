#!/usr/bin/env bash

##################################################################################################

# This script creates folders and downloads the media samples needed for running LVA             #

##################################################################################################

sudo groupadd -g 1010 localusergroup
sudo useradd --home-dir /home/lvaedgeuser --uid 1010 --gid 1010 lvaedgeuser
sudo mkdir -p /home/lvaedgeuser

sudo mkdir -p /home/lvaedgeuser/samples
sudo mkdir -p /home/lvaedgeuser/samples/input

sudo curl https://lvamedia.blob.core.windows.net/public/camera-300s.mkv --output /home/lvaedgeuser/samples/input/camera-300s.mkv
sudo curl https://lvamedia.blob.core.windows.net/public/lots_284.mkv --output /home/lvaedgeuser/samples/input/lots_284.mkv
sudo curl https://lvamedia.blob.core.windows.net/public/lots_015.mkv --output /home/lvaedgeuser/samples/input/lots_015.mkv
sudo curl https://lvamedia.blob.core.windows.net/public/t2.mkv --output /home/lvaedgeuser/samples/input/t2.mkv

sudo mkdir -p /var/lib/azuremediaservices
sudo mkdir -p /var/media

sudo chown -R lvaedgeuser:localusergroup /var/lib/azuremediaservices/
sudo chown -R lvaedgeuser:localusergroup /var/media/

sudo chown -R lvaedgeuser:localusergroup /home/lvaedgeuser/