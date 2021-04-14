#!/usr/bin/env bash

#######################################################################################################################
# This script deploys resources in Azure for use with Azure Media Services Live Video Analytics samples.              #
# It is primarily meant to run in https://shell.azure.com/ in the Bash environment. (It will not work in PowerShell.) #
#                                                                                                                     #
# You will need an Azure subscription with permissions for creating service principals (owner role provides this).    #                                                                                                                
#                                                                                                                     #
# Do not be in the habit of executing scripts from the internet with root-level access to your machine. Only trust    #
# well-known publishers.                                                                                              #
#######################################################################################################################

# colors for formatting the ouput
YELLOW='\033[1;33m'
GREEN='\033[1;32m'
RED='\033[0;31m'
BLUE='\033[1;34m'
NC='\033[0m' # No Color

# script configuration
BASE_URL='https://raw.githubusercontent.com/Azure/live-video-analytics/master/edge/setup' # location of remote files used by the script
DEFAULT_REGION='centralus'
ENV_FILE='edge-deployment/.env'
APP_SETTINGS_FILE='appsettings.json'
VM_CREDENTIALS_FILE='vm-edge-device-credentials.txt'
ARM_TEMPLATE_URL="$BASE_URL/deploy.json"
CLOUD_INIT_URL="$BASE_URL/cloud-init.yml"
CLOUD_INIT_FILE='cloud-init.yml'
DEPLOYMENT_MANIFEST_URL="$BASE_URL/deployment.template.json"
DEPLOYMENT_MANIFEST_FILE='edge-deployment/deployment.amd64.json'
RESOURCE_GROUP='lva-sample-resources'
IOT_EDGE_VM_NAME='lva-sample-iot-edge-device'
IOT_EDGE_VM_ADMIN='lvaadmin'
IOT_EDGE_VM_PWD="Password@$(shuf -i 1000-9999 -n 1)"
CLOUD_SHELL_FOLDER="$HOME/clouddrive/lva-sample"
APPDATA_FOLDER_ON_DEVICE="/var/lib/azuremediaservices"
BYOD_FOLDER="$HOME/lva_byod"
BYOD_ARM_TEMPLATE_URL="$BASE_URL/byod_deploy.json"
BYOD_DEPLOYMENT_MANIFEST_FILE="$BYOD_FOLDER/deployment.amd64.json"
BYOD_ENV_FILE="$BYOD_FOLDER/.env"
BYOD_APP_SETTINGS_FILE="$BYOD_FOLDER/appsettings.json"

checkForError() {
    if [ $? -ne 0 ]; then
        echo -e "\n${RED}Something went wrong:${NC}
    Please read any error messages carefully.
    After addressing any errors, you can safely run this script again.
    Note:
    - If you rerun the script with the same subscription and resource group,
      it will attempt to continue where it left off.
    - Some problems with Azure Cloud Shell may be restarting from the toolbar:
      https://docs.microsoft.com/azure/cloud-shell/using-the-shell-window#restart-cloud-shell
    "
        exit 1
    fi
}

# let's begin!
echo -e "
Welcome! \U1F9D9\n
This script will set up a number of prerequisite resources so 
that you can run the ${BLUE}Live Video Analytics${NC} samples.
"
sleep 2 # time for the reader 

# configure ouput location base if running in Cloud Shell
if [ "$AZURE_HTTP_USER_AGENT" = "cloud-shell/1.0" ]; then
    ENV_FILE="$CLOUD_SHELL_FOLDER/$ENV_FILE"
    APP_SETTINGS_FILE="$CLOUD_SHELL_FOLDER/$APP_SETTINGS_FILE"
    VM_CREDENTIALS_FILE="$CLOUD_SHELL_FOLDER/$VM_CREDENTIALS_FILE"
    CLOUD_INIT_FILE="$CLOUD_SHELL_FOLDER/$CLOUD_INIT_FILE"
    DEPLOYMENT_MANIFEST_FILE="$CLOUD_SHELL_FOLDER/$DEPLOYMENT_MANIFEST_FILE"
    BYOD_ENV_FILE="$BYOD_ENV_FILE"
    BYOD_DEPLOYMENT_MANIFEST_FILE="$BYOD_DEPLOYMENT_MANIFEST_FILE"
	BYOD_APP_SETTINGS_FILE="$BYOD_APP_SETTINGS_FILE"
fi

echo "Initialzing output files.
This overwrites any output files previously generated."
mkdir -p $(dirname $ENV_FILE) && echo -n "" > $ENV_FILE
mkdir -p $(dirname $APP_SETTINGS_FILE) && echo -n "" > $APP_SETTINGS_FILE
mkdir -p $(dirname $VM_CREDENTIALS_FILE) && echo -n "" > $VM_CREDENTIALS_FILE
mkdir -p $(dirname $DEPLOYMENT_MANIFEST_FILE) && echo -n "" > $DEPLOYMENT_MANIFEST_FILE
mkdir -p $(dirname $BYOD_ENV_FILE) && echo -n "" > $BYOD_ENV_FILE
mkdir -p $(dirname $BYOD_APP_SETTINGS_FILE) && echo -n "" > $BYOD_APP_SETTINGS_FILE
mkdir -p $(dirname $BYOD_DEPLOYMENT_MANIFEST_FILE) && echo -n "" > $BYOD_DEPLOYMENT_MANIFEST_FILE

# install the Azure IoT extension
echo -e "Checking ${BLUE}azure-iot${NC} extension."
az extension show -n azure-iot -o none &> /dev/null
if [ $? -ne 0 ]; then
    echo -e "${BLUE}azure-iot${NC} extension not found. Installing ${BLUE}azure-iot${NC}."
    az extension add --name azure-iot &> /dev/null
    echo -e "${BLUE}azure-iot${NC} extension is now installed."
else
    az extension update --name azure-iot &> /dev/null
    echo -e "${BLUE}azure-iot${NC} extension is up to date."														  
fi


# check if we need to log in
# if we are executing in the Azure Cloud Shell, we should already be logged in
az account show -o none
if [ $? -ne 0 ]; then
    echo -e "\nRunning 'az login' for you."
    az login -o none
fi


# query subscriptions
echo -e "\n${GREEN}You have access to the following subscriptions:${NC}"
az account list --query '[].{name:name,"subscription Id":id}' --output table

echo -e "\n${GREEN}Your current subscription is:${NC}"
az account show --query '[name,id]'


echo -e "
You will need to use a subscription with permissions for creating service principals (owner role provides this).
${YELLOW}If you want to change to a different subscription, enter the name or id.${NC}
Or just press enter to continue with the current subscription."
read -p ">> " SUBSCRIPTION_ID

if ! test -z "$SUBSCRIPTION_ID"
then 
    az account set -s "$SUBSCRIPTION_ID"
    echo -e "\n${GREEN}Now using:${NC}"
    az account show --query '[name,id]'
fi 

# select a region for deployment
echo -e "
${YELLOW}Please select a region to deploy resources from this list: centralus, eastus2, francecentral, japanwest, northcentralus, uksouth, westcentralus, westus2, australiaeast, eastasia, southeastasia, japaneast, eastus, ukwest, westus, canadacentral, koreacentral, southcentralus, australiasoutheast, centralindia, brazilsouth, westeurope, northeurope.${NC}
Or just press enter to use ${DEFAULT_REGION}."
read -p ">> " REGION

if [[ "$REGION" =~ ^(centralus|eastus2|francecentral|japanwest|northcentralus|uksouth|westcentralus|westus2|australiaeast|eastasia|southeastasia|japaneast|eastus|ukwest|westus|canadacentral|koreacentral|southcentralus|australiasoutheast|centralindia|brazilsouth|westeurope|northeurope)$ ]]; then
    echo -e "\n${GREEN}Now using:${NC} $REGION"
else
    echo -e "\n${GREEN}Defaulting to:${NC} ${DEFAULT_REGION}"
    REGION=${DEFAULT_REGION}
fi

echo -e "
Would you like to use your own edge device as an IoT edge device?
If so enter ${YELLOW}Y${NC} otherwise ${YELLOW}N${NC}."
read -p ">> " temp
OWN_DEVICE=${temp^^}
 
##################################################################################################################################################  
if [[ "$OWN_DEVICE" == "N" ]]; then
    # choose a resource group
    echo -e "
    ${YELLOW}What is the name of the resource group to use?${NC}
    This will create a new resource group if one doesn't exist.
    Hit enter to use the default (${BLUE}${RESOURCE_GROUP}${NC})."
    read -p ">> " tmp
    RESOURCE_GROUP=${tmp:-$RESOURCE_GROUP}
    EXISTING=$(az group exists -g ${RESOURCE_GROUP})

    if ! $EXISTING; then
        echo -e "\n${GREEN}The resource group does not currently exist.${NC}"
        echo -e "We'll create it in ${BLUE}${REGION}${NC}."
        az group create --name ${RESOURCE_GROUP} --location ${REGION} -o none
        checkForError
    fi

    # deploy resources using a template
    echo -e "
    Now we'll deploy some resources to ${GREEN}${RESOURCE_GROUP}.${NC}
    This typically takes about 6 minutes, but the time may vary.

    The resources are defined in a template here:
    ${BLUE}${ARM_TEMPLATE_URL}${NC}"

    az deployment group create --resource-group $RESOURCE_GROUP --template-uri $ARM_TEMPLATE_URL -o none
    checkForError

    # query the resource group to see what has been deployed
    # this includes everything in the resource group, and not just the resources deployed by the template
    echo -e "\nResource group now contains these resources:"
    RESOURCES=$(az resource list --resource-group $RESOURCE_GROUP --query '[].{name:name,"Resource Type":type}' -o table)
    echo "${RESOURCES}"

    # capture resource configuration in variables
    IOTHUB=$(echo "${RESOURCES}" | awk '$2 ~ /Microsoft.Devices\/IotHubs$/ {print $1}')
    AMS_ACCOUNT=$(echo "${RESOURCES}" | awk '$2 ~ /Microsoft.Media\/mediaservices$/ {print $1}')
    VNET=$(echo "${RESOURCES}" | awk '$2 ~ /Microsoft.Network\/virtualNetworks$/ {print $1}')
    EDGE_DEVICE="lva-sample-device"
    IOTHUB_CONNECTION_STRING=$(az iot hub connection-string show --hub-name ${IOTHUB} --query='connectionString')
    CONTAINER_REGISTRY=$(echo "${RESOURCES}" | awk '$2 ~ /Microsoft.ContainerRegistry\/registries$/ {print $1}')
    CONTAINER_REGISTRY_USERNAME=$(az acr credential show -n $CONTAINER_REGISTRY --query 'username' | tr -d \")
    CONTAINER_REGISTRY_PASSWORD=$(az acr credential show -n $CONTAINER_REGISTRY --query 'passwords[0].value' | tr -d \")

    echo -e "
    Some of the configuration for these resources can't be performed using a template.
    So, we'll handle these for you now:
    - register an IoT Edge device with the IoT Hub
    - set up a service principal (app registration) for the Media Services account
    "

    # configure the hub for an edge device
    echo "registering device..."
    if test -z "$(az iot hub device-identity list -n $IOTHUB | grep "deviceId" | grep $EDGE_DEVICE)"; then
        az iot hub device-identity create --hub-name $IOTHUB --device-id $EDGE_DEVICE --edge-enabled -o none
        checkForError
    fi
    DEVICE_CONNECTION_STRING=$(az iot hub device-identity connection-string show --device-id $EDGE_DEVICE --hub-name $IOTHUB --query='connectionString')

    # creating the AMS account creates a service principal, so we'll just reset it to get the credentials
    echo "setting up service principal..."
    SPN="$AMS_ACCOUNT-access-sp" # this is the default naming convention used by `az ams account sp`

    if test -z "$(az ad sp list --display-name $SPN --query="[].displayName" -o tsv)"; then
        AMS_CONNECTION=$(az ams account sp create -o yaml --resource-group $RESOURCE_GROUP --account-name $AMS_ACCOUNT)
    else
        AMS_CONNECTION=$(az ams account sp reset-credentials -o yaml --resource-group $RESOURCE_GROUP --account-name $AMS_ACCOUNT)
    fi

    # capture config information
    re="AadTenantId:\s([0-9a-z\-]*)"
    AAD_TENANT_ID=$([[ "$AMS_CONNECTION" =~ $re ]] && echo ${BASH_REMATCH[1]})

    re="AadClientId:\s([0-9a-z\-]*)"
    AAD_SERVICE_PRINCIPAL_ID=$([[ "$AMS_CONNECTION" =~ $re ]] && echo ${BASH_REMATCH[1]})

    re="AadSecret:\s([0-9a-z\-]*)"
    AAD_SERVICE_PRINCIPAL_SECRET=$([[ "$AMS_CONNECTION" =~ $re ]] && echo ${BASH_REMATCH[1]})

    re="SubscriptionId:\s([0-9a-z\-]*)"
    SUBSCRIPTION_ID=$([[ "$AMS_CONNECTION" =~ $re ]] && echo ${BASH_REMATCH[1]})

    # capture object_id
    OBJECT_ID=$(az ad sp show --id ${AAD_SERVICE_PRINCIPAL_ID} --query 'objectId' | tr -d \")

    echo -e "
    Updating the Media Services account to use one ${YELLOW}Premium${NC} streaming endpoint."
    az ams streaming-endpoint scale --resource-group $RESOURCE_GROUP --account-name $AMS_ACCOUNT -n default --scale-units 1

    echo "Kicking off the async start of the Premium streaming endpoint."
    echo "  This is needed to run samples or tutorials involving video playback."
    az ams streaming-endpoint start --resource-group $RESOURCE_GROUP --account-name $AMS_ACCOUNT -n default --no-wait

    # deploy the IoT Edge runtime on a VM
    az vm show -n $IOT_EDGE_VM_NAME -g $RESOURCE_GROUP &> /dev/null
    if [ $? -ne 0 ]; then
        echo -e "
    Finally, we'll deploy a VM that will act as your IoT Edge device for using the LVA samples."
        curl -s $CLOUD_INIT_URL > $CLOUD_INIT_FILE
        # here be dragons
        # sometimes a / is present in the connection string and it breaks sed
        # this escapes the /
        DEVICE_CONNECTION_STRING=${DEVICE_CONNECTION_STRING//\//\\/} 
        sed -i "s/xDEVICE_CONNECTION_STRINGx/${DEVICE_CONNECTION_STRING//\"/}/g" $CLOUD_INIT_FILE

        az vm create \
        --resource-group $RESOURCE_GROUP \
        --name $IOT_EDGE_VM_NAME \
        --image Canonical:UbuntuServer:18.04-LTS:latest \
        --admin-username $IOT_EDGE_VM_ADMIN \
        --admin-password $IOT_EDGE_VM_PWD \
        --vnet-name $VNET \
        --subnet 'default' \
        --custom-data $CLOUD_INIT_FILE \
        --public-ip-address "" \
        --size "Standard_DS3_v2" \
        --tags sample=lva \
        --output none
        checkForError
        echo -e "
    To access the VM acting as the IoT Edge device, 
    - locate it in the portal 
    - click Connect on the toolbar and choose Bastion
    - enter the username and password below

    The VM is named ${GREEN}$IOT_EDGE_VM_NAME${NC}
    Username ${GREEN}$IOT_EDGE_VM_ADMIN${NC}
    Password ${GREEN}$IOT_EDGE_VM_PWD${NC}

    This information can be found here:
    ${BLUE}$VM_CREDENTIALS_FILE${NC}"

        echo $IOT_EDGE_VM_NAME >> $VM_CREDENTIALS_FILE
        echo $IOT_EDGE_VM_ADMIN >> $VM_CREDENTIALS_FILE
        echo $IOT_EDGE_VM_PWD >> $VM_CREDENTIALS_FILE

    else
        echo -e "
    ${YELLOW}NOTE${NC}: A VM named ${YELLOW}$IOT_EDGE_VM_NAME${NC} was found in ${YELLOW}${RESOURCE_GROUP}.${NC}
    We will not attempt to redeploy the VM."
    fi

    # write env file for edge deployment
    echo "SUBSCRIPTION_ID=\"$SUBSCRIPTION_ID\"" >> $ENV_FILE
    echo "RESOURCE_GROUP=\"$RESOURCE_GROUP\"" >> $ENV_FILE
    echo "AMS_ACCOUNT=\"$AMS_ACCOUNT\"" >> $ENV_FILE
    echo "IOTHUB_CONNECTION_STRING=$IOTHUB_CONNECTION_STRING" >> $ENV_FILE
    echo "AAD_TENANT_ID=$AAD_TENANT_ID" >> $ENV_FILE
    echo "AAD_SERVICE_PRINCIPAL_ID=$AAD_SERVICE_PRINCIPAL_ID" >> $ENV_FILE
    echo "AAD_SERVICE_PRINCIPAL_SECRET=$AAD_SERVICE_PRINCIPAL_SECRET" >> $ENV_FILE
    echo "VIDEO_INPUT_FOLDER_ON_DEVICE=\"/home/lvaadmin/samples/input\"" >> $ENV_FILE
    echo "VIDEO_OUTPUT_FOLDER_ON_DEVICE=\"/var/media\"" >> $ENV_FILE
    echo "APPDATA_FOLDER_ON_DEVICE=\"/var/lib/azuremediaservices\"" >> $ENV_FILE
    echo "CONTAINER_REGISTRY_USERNAME_myacr=$CONTAINER_REGISTRY_USERNAME" >> $ENV_FILE
    echo "CONTAINER_REGISTRY_PASSWORD_myacr=$CONTAINER_REGISTRY_PASSWORD" >> $ENV_FILE

    echo -e "
    We've generated some configuration files for the deployed resource.
    This .env can be used with the ${GREEN}Azure IoT Tools${NC} extension in ${GREEN}Visual Studio Code${NC}.
    You can find it here:
    ${BLUE}${ENV_FILE}${NC}"

    # write appsettings for sample code
    echo "{" >> $APP_SETTINGS_FILE
    echo "    \"IoThubConnectionString\" : $IOTHUB_CONNECTION_STRING," >> $APP_SETTINGS_FILE
    echo "    \"deviceId\" : \"$EDGE_DEVICE\"," >> $APP_SETTINGS_FILE
    echo "    \"moduleId\" : \"lvaEdge\"" >> $APP_SETTINGS_FILE
    echo -n "}" >> $APP_SETTINGS_FILE

    # set up deployment manifest
    curl -s $DEPLOYMENT_MANIFEST_URL > $DEPLOYMENT_MANIFEST_FILE

    sed -i "s/\$CONTAINER_REGISTRY_USERNAME_myacr/$CONTAINER_REGISTRY_USERNAME/" $DEPLOYMENT_MANIFEST_FILE
    sed -i "s/\$CONTAINER_REGISTRY_PASSWORD_myacr/${CONTAINER_REGISTRY_PASSWORD//\//\\/}/" $DEPLOYMENT_MANIFEST_FILE
    sed -i "s/\$VIDEO_INPUT_FOLDER_ON_DEVICE/\/home\/lvaedgeuser\/samples\/input/" $DEPLOYMENT_MANIFEST_FILE
    sed -i "s/\$SUBSCRIPTION_ID/$SUBSCRIPTION_ID/" $DEPLOYMENT_MANIFEST_FILE
    sed -i "s/\$RESOURCE_GROUP/$RESOURCE_GROUP/" $DEPLOYMENT_MANIFEST_FILE
    sed -i "s/\$AMS_ACCOUNT/$AMS_ACCOUNT/" $DEPLOYMENT_MANIFEST_FILE
    sed -i "s/\$AAD_TENANT_ID/$AAD_TENANT_ID/" $DEPLOYMENT_MANIFEST_FILE
    sed -i "s/\$AAD_SERVICE_PRINCIPAL_ID/$AAD_SERVICE_PRINCIPAL_ID/" $DEPLOYMENT_MANIFEST_FILE
    sed -i "s/\$AAD_SERVICE_PRINCIPAL_SECRET/$AAD_SERVICE_PRINCIPAL_SECRET/" $DEPLOYMENT_MANIFEST_FILE
    sed -i "s/\$VIDEO_OUTPUT_FOLDER_ON_DEVICE/\/var\/media/" $DEPLOYMENT_MANIFEST_FILE
    sed -i "s/\$APPDATA_FOLDER_ON_DEVICE/${APPDATA_FOLDER_ON_DEVICE//\//\\/}/" $DEPLOYMENT_MANIFEST_FILE

    echo -e "
    The appsettings.json file is for the .NET Core sample application.
    You can find it here:
    ${BLUE}${APP_SETTINGS_FILE}${NC}"

    echo -e "
    You can find the deployment manifest file here:
    - ${BLUE}${DEPLOYMENT_MANIFEST_FILE}${NC}"

    echo -e "

    Next, copy these generated files into your local copy of the sample app:
    - ${BLUE}${APP_SETTINGS_FILE}${NC}
    - ${BLUE}${ENV_FILE}${NC}

    ${GREEN}All done!${NC} \U1F44D\n

    Go to ${GREEN}https://aka.ms/lva-edge-quickstart${NC} to learn more about getting started with ${BLUE}Live Video Analytics${NC} on IoT Edge.					
    "

##################################################################################################################################################    

elif [[ "$OWN_DEVICE" = "Y" ]]; then
    # get edge device information
    echo -e "\nWhat is the ${YELLOW}device ID${NC} of the Linux edge device that you want to use?"
    read -p ">> " EDGE_DEVICE_ID

    # get IoT Hub information
    echo -e "\nWhat is the name of the ${YELLOW}IoT Hub${NC} that you want to use?"
    read -p ">> " IOTHUB

    # get resource group name
    RESOURCE_GROUP=$(az resource list --name $IOTHUB --query [0].resourceGroup | tr -d \")
    checkForError

    # deploy resources using a template
    echo -e "\nNow we'll deploy some resources to ${GREEN}${RESOURCE_GROUP}.${NC} This typically takes a few minutes."
    echo -e "\nThe resources are defined in a template here:- ${BLUE}${BYOD_ARM_TEMPLATE_URL}${NC}"

    az deployment group create --resource-group $RESOURCE_GROUP --template-uri $BYOD_ARM_TEMPLATE_URL --parameters hubName=$IOTHUB -o none
    checkForError
  
    # query the resource group to see what has been deployed
    # this includes everything in the resource group, and not just the resources deployed by the template
    echo -e "\nResource group now contains these resources:"
    RESOURCES=$(az resource list --resource-group $RESOURCE_GROUP --query '[].{name:name,"Resource Type":type}' -o table)
    echo "${RESOURCES}"

    # capture resource configuration in variables
    AMS_ACCOUNT=$(echo "${RESOURCES}" | awk '$2 ~ /Microsoft.Media\/mediaservices$/ {print $1}')
    IOTHUB_CONNECTION_STRING=$(az iot hub connection-string show --hub-name ${IOTHUB} --query='connectionString')
    CONTAINER_REGISTRY=$(echo "${RESOURCES}" | awk '$2 ~ /Microsoft.ContainerRegistry\/registries$/ {print $1}')
    CONTAINER_REGISTRY_USERNAME=$(az acr credential show -n $CONTAINER_REGISTRY --query 'username' | tr -d \")
    CONTAINER_REGISTRY_PASSWORD=$(az acr credential show -n $CONTAINER_REGISTRY --query 'passwords[0].value' | tr -d \")

    echo -e "
    Some of the configuration for these resources can't be performed using a template.
    So, we'll handle these for you now:
    - register an IoT Edge device with the IoT Hub
    - set up a service principal (app registration) for the Media Services account
    "


    # configure the hub for an edge device
    echo "registering device..."
    if test -z "$(az iot hub device-identity list -n $IOTHUB | grep "deviceId" | grep $EDGE_DEVICE_ID)"; then
        az iot hub device-identity create --hub-name $IOTHUB --device-id $EDGE_DEVICE_ID --edge-enabled -o none
        checkForError
    fi
    DEVICE_CONNECTION_STRING=$(az iot hub device-identity connection-string show --device-id $EDGE_DEVICE_ID --hub-name $IOTHUB --query='connectionString')

    # creating the AMS account creates a service principal, so we'll just reset it to get the credentials
    echo "setting up service principal..."
    SPN="$AMS_ACCOUNT-access-sp" # this is the default naming convention used by `az ams account sp`

    if test -z "$(az ad sp list --display-name $SPN --query="[].displayName" -o tsv)"; then
       AMS_CONNECTION=$(az ams account sp create -o yaml --resource-group $RESOURCE_GROUP --account-name $AMS_ACCOUNT)
    else
       AMS_CONNECTION=$(az ams account sp reset-credentials -o yaml --resource-group $RESOURCE_GROUP --account-name $AMS_ACCOUNT)
    fi

    # capture config information
    re="AadTenantId:\s([0-9a-z\-]*)"
    AAD_TENANT_ID=$([[ "$AMS_CONNECTION" =~ $re ]] && echo ${BASH_REMATCH[1]})

    re="AadClientId:\s([0-9a-z\-]*)"
    AAD_SERVICE_PRINCIPAL_ID=$([[ "$AMS_CONNECTION" =~ $re ]] && echo ${BASH_REMATCH[1]})

    re="AadSecret:\s([0-9a-z\-]*)"
    AAD_SERVICE_PRINCIPAL_SECRET=$([[ "$AMS_CONNECTION" =~ $re ]] && echo ${BASH_REMATCH[1]})

    re="SubscriptionId:\s([0-9a-z\-]*)"
    SUBSCRIPTION_ID=$([[ "$AMS_CONNECTION" =~ $re ]] && echo ${BASH_REMATCH[1]})

    # capture object_id
    OBJECT_ID=$(az ad sp show --id ${AAD_SERVICE_PRINCIPAL_ID} --query 'objectId' | tr -d \")

    # The brand-new AMS account has a standard streaming endpoint in stopped state. 
    # A Premium streaming endpoint is recommended when recording multiple days worth of video

	sleep 60

    echo -e "
    Updating the Media Services account to use one ${YELLOW}Premium${NC} streaming endpoint."
    az ams streaming-endpoint scale --resource-group $RESOURCE_GROUP --account-name $AMS_ACCOUNT -n default --scale-units 1

    echo "Kicking off the async start of the Premium streaming endpoint."
    echo "  This is needed to run samples or tutorials involving video playback."
    az ams streaming-endpoint start --resource-group $RESOURCE_GROUP --account-name $AMS_ACCOUNT -n default --no-wait

    # create a directory to store the env, appsettings and the deployment maifest file
    mkdir $BYOD_FOLDER

    # write env file for edge deployment
    echo "SUBSCRIPTION_ID=\"$SUBSCRIPTION_ID\"" >> $BYOD_ENV_FILE
    echo "RESOURCE_GROUP=\"$RESOURCE_GROUP\"" >> $BYOD_ENV_FILE
    echo "AMS_ACCOUNT=\"$AMS_ACCOUNT\"" >> $BYOD_ENV_FILE
    echo "IOTHUB_CONNECTION_STRING=$IOTHUB_CONNECTION_STRING" >> $BYOD_ENV_FILE
    echo "AAD_TENANT_ID=$AAD_TENANT_ID" >> $BYOD_ENV_FILE
    echo "AAD_SERVICE_PRINCIPAL_ID=$AAD_SERVICE_PRINCIPAL_ID" >> $BYOD_ENV_FILE
    echo "AAD_SERVICE_PRINCIPAL_SECRET=$AAD_SERVICE_PRINCIPAL_SECRET" >> $BYOD_ENV_FILE
    echo "VIDEO_INPUT_FOLDER_ON_DEVICE=\"/home/lvaedgeuser/samples/input\"" >> $BYOD_ENV_FILE
    echo "VIDEO_OUTPUT_FOLDER_ON_DEVICE=\"/var/media\"" >> $BYOD_ENV_FILE
    echo "APPDATA_FOLDER_ON_DEVICE=\"/var/lib/azuremediaservices\"" >> $BYOD_ENV_FILE
    echo "CONTAINER_REGISTRY_USERNAME_myacr=$CONTAINER_REGISTRY_USERNAME" >> $BYOD_ENV_FILE
    echo "CONTAINER_REGISTRY_PASSWORD_myacr=$CONTAINER_REGISTRY_PASSWORD" >> $BYOD_ENV_FILE

    echo -e "
    We've generated some configuration files for the deployed resource.
    This .env can be used with the ${GREEN}Azure IoT Tools${NC} extension in ${GREEN}Visual Studio Code${NC}.
    You can find it here:
    ${BLUE}${BYOD_ENV_FILE}${NC}"

    # write appsettings for sample code
    echo "{" >> $BYOD_APP_SETTINGS_FILE
    echo "    \"IoThubConnectionString\" : $IOTHUB_CONNECTION_STRING," >> $BYOD_APP_SETTINGS_FILE
    echo "    \"deviceId\" : \"$EDGE_DEVICE_ID\"," >> $BYOD_APP_SETTINGS_FILE
    echo "    \"moduleId\" : \"lvaEdge\"" >> $BYOD_APP_SETTINGS_FILE
    echo -n "}" >> $BYOD_APP_SETTINGS_FILE


    # set up deployment manifest
    curl -s $DEPLOYMENT_MANIFEST_URL > $BYOD_DEPLOYMENT_MANIFEST_FILE

    sed -i "s/\$CONTAINER_REGISTRY_USERNAME_myacr/$CONTAINER_REGISTRY_USERNAME/" $BYOD_DEPLOYMENT_MANIFEST_FILE
    sed -i "s/\$CONTAINER_REGISTRY_PASSWORD_myacr/${CONTAINER_REGISTRY_PASSWORD//\//\\/}/" $BYOD_DEPLOYMENT_MANIFEST_FILE
    sed -i "s/\$VIDEO_INPUT_FOLDER_ON_DEVICE/\/home\/lvaedgeuser\/samples\/input/" $BYOD_DEPLOYMENT_MANIFEST_FILE
    sed -i "s/\$SUBSCRIPTION_ID/$SUBSCRIPTION_ID/" $BYOD_DEPLOYMENT_MANIFEST_FILE
    sed -i "s/\$RESOURCE_GROUP/$RESOURCE_GROUP/" $BYOD_DEPLOYMENT_MANIFEST_FILE
    sed -i "s/\$AMS_ACCOUNT/$AMS_ACCOUNT/" $BYOD_DEPLOYMENT_MANIFEST_FILE
    sed -i "s/\$AAD_TENANT_ID/$AAD_TENANT_ID/" $BYOD_DEPLOYMENT_MANIFEST_FILE
    sed -i "s/\$AAD_SERVICE_PRINCIPAL_ID/$AAD_SERVICE_PRINCIPAL_ID/" $BYOD_DEPLOYMENT_MANIFEST_FILE
    sed -i "s/\$AAD_SERVICE_PRINCIPAL_SECRET/$AAD_SERVICE_PRINCIPAL_SECRET/" $BYOD_DEPLOYMENT_MANIFEST_FILE
    sed -i "s/\$VIDEO_OUTPUT_FOLDER_ON_DEVICE/\/var\/media/" $BYOD_DEPLOYMENT_MANIFEST_FILE
    sed -i "s/\$APPDATA_FOLDER_ON_DEVICE/${APPDATA_FOLDER_ON_DEVICE//\//\\/}/" $BYOD_DEPLOYMENT_MANIFEST_FILE

    echo -e "
    The appsettings.json file is for the .NET Core sample application.
    You can find it here:
    ${BLUE}${BYOD_APP_SETTINGS_FILE}${NC}"

    echo -e "
    You can find the deployment manifest file here:
    - ${BLUE}${BYOD_DEPLOYMENT_MANIFEST_FILE}${NC}"

    # deploy the manifest file
    echo -e "
    Here is the list of modules deployed to your edge device:"
    az iot edge set-modules --hub-name $IOTHUB --device-id $EDGE_DEVICE_ID --content $BYOD_FOLDER/deployment.amd64.json

    #################################################################################################################################################
    echo -e "
    ${GREEN}All done!${NC} \U1F44D\n					
    "
    #################################################################################################################################################
fi

# cleanup

# rm $CLOUD_INIT_FILE &> /dev/null
