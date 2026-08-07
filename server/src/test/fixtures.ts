/** Shared Salesforce source fixtures for P0.2 tests. */

export const INVOICE_OBJECT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Invoice</label>
    <fields>
        <fullName>Amount__c</fullName>
        <type>Currency</type>
    </fields>
    <fields>
        <fullName>Status__c</fullName>
        <type>Picklist</type>
    </fields>
    <fields>
        <fullName>Account__c</fullName>
        <type>Lookup</type>
        <referenceTo>Account</referenceTo>
    </fields>
    <validationRules>
        <fullName>Positive_Amount</fullName>
        <errorConditionFormula>Amount__c &lt; 0</errorConditionFormula>
        <errorMessage>Amount must be positive</errorMessage>
    </validationRules>
</CustomObject>
`;

export const SEND_INVOICE_FLOW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Send Invoice</label>
    <recordLookups>
        <name>Get_Invoice</name>
        <object>Invoice__c</object>
        <queriedFields>Amount__c</queriedFields>
        <filters>
            <field>Status__c</field>
            <operator>EqualTo</operator>
        </filters>
    </recordLookups>
    <actionCalls>
        <name>Call_Service</name>
        <actionName>InvoiceService</actionName>
        <actionType>apex</actionType>
    </actionCalls>
    <subflows>
        <name>Alert</name>
        <flowName>Send_Alert</flowName>
    </subflows>
</Flow>
`;

export const INVOICE_SERVICE_APEX = `public with sharing class InvoiceService {
    // touches InvoiceHelper and the Invoice__c object
    public static void run() {
        List<Invoice__c> invs = [SELECT Id, Amount__c FROM Invoice__c WHERE Status__c = 'Open'];
        InvoiceHelper.process(invs);
        System.debug(Label.Invoice_Alert);
        // 'Account' inside this string literal must NOT produce a ref: 'Account is great'
    }
}
`;

export const INVOICE_HELPER_APEX = `public with sharing class InvoiceHelper {
    public static void process(List<Invoice__c> invs) {}
}
`;

export const CUSTOM_LABELS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">
    <labels>
        <fullName>Invoice_Alert</fullName>
        <value>Invoice needs attention</value>
        <language>en_US</language>
    </labels>
</CustomLabels>
`;
